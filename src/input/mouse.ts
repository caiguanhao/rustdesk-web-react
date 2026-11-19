/**
 * DOM mouse → RustDesk `MouseEvent` encoder (P3-1).
 *
 * Wire format (RustDesk `src/common.rs`): the low 3 bits are the action
 * (move=0, down=1, up=2, wheel=3) and the button bit is shifted left by 3
 * (left=1<<3, right=2<<3, middle=4<<3, back=8<<3, forward=16<<3). Down/up
 * events carry x=y=0; only moves carry absolute display coordinates and only
 * wheel events carry deltas. The server applies a down's modifier list and
 * ignores modifiers on move/up.
 *
 * IMPORTANT wheel note: the DOM sign (`deltaY > 0` = scroll down) is the
 * opposite of RustDesk's wire sign. Official clients (v1/v2 web Flutter and the
 * Rust client) negate each axis before sending, and the server negates y again
 * for non-Windows peers. Forwarding raw DOM deltas would scroll the wrong way
 * on Windows. We therefore emit ±1 notch signs for the dominant axis, matching
 * the official client; magnitudes are not raw DOM pixels (Windows multiplies
 * wire values by 120). The old spec note "do not negate" applies only to the
 * web core bridge, which receives already-negated values from Flutter.
 *
 * Coordinates are frame pixels from `VideoRenderer.toRemote()` plus the
 * display origin from `PeerInfo.displays[currentDisplay]` (P4-1 keeps it in
 * sync on display switches). Down/up carry 0,0 but are always preceded by a
 * move so the peer cursor is at the click point.
 */
import type { RelayConnection } from '../protocol/connection.js';
import { ControlKey } from '../protocol/message.js';
import { RustDeskError } from '../session/errors.js';
import {
  mapClientPoint,
  type RemoteCoordinateMapper,
} from './coordinates.js';

export type { RemoteCoordinateMapper, RemotePoint } from './coordinates.js';

export const MOUSE_TYPE = { move: 0, down: 1, up: 2, wheel: 3 } as const;
export const MOUSE_BUTTON = {
  left: 1,
  right: 2,
  middle: 4,
  back: 8,
  forward: 16,
} as const;

export type MouseMessageType = keyof typeof MOUSE_TYPE;
export type MouseButtonBit = (typeof MOUSE_BUTTON)[keyof typeof MOUSE_BUTTON];

export type MouseChannel = Pick<RelayConnection, 'sendMessage'>;

/** Display origin from PeerInfo, defaulting invalid/missing components to 0. */
export function normalizeOrigin(
  origin?: { x: number; y: number },
): { x: number; y: number } {
  const x = origin?.x;
  const y = origin?.y;
  return {
    x: x !== undefined && Number.isFinite(x) ? x : 0,
    y: y !== undefined && Number.isFinite(y) ? y : 0,
  };
}

export interface MouseInputOptions {
  /** Element that receives pointer input (normally the video canvas). */
  element: HTMLElement;
  /** Normally the VideoRenderer; tests can inject a fake mapper. */
  mapper: RemoteCoordinateMapper;
  channel: MouseChannel;
  /** Display origin from `PeerInfo.displays[currentDisplay]`; default 0,0. */
  origin?: { x: number; y: number };
  /** Policy hook for read-only/permission states; default true. */
  enabled?: boolean;
  /** Suppress the local context menu; default true. */
  preventContextMenu?: boolean;
  onError?: (error: RustDeskError) => void;
}

export function mouseMask(type: MouseMessageType, buttonBits = 0): number {
  return MOUSE_TYPE[type] | (buttonBits << 3);
}

/** DOM `MouseEvent.button` (0 left, 1 middle, 2 right, 3 back, 4 forward). */
export function domButtonBit(button: number): MouseButtonBit | null {
  switch (button) {
    case 0:
      return MOUSE_BUTTON.left;
    case 1:
      return MOUSE_BUTTON.middle;
    case 2:
      return MOUSE_BUTTON.right;
    case 3:
      return MOUSE_BUTTON.back;
    case 4:
      return MOUSE_BUTTON.forward;
    default:
      return null;
  }
}

export function mouseModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): ControlKey[] {
  const modifiers: ControlKey[] = [];
  if (event.altKey) modifiers.push(ControlKey.Alt);
  if (event.ctrlKey) modifiers.push(ControlKey.Control);
  if (event.shiftKey) modifiers.push(ControlKey.Shift);
  if (event.metaKey) modifiers.push(ControlKey.Meta);
  return modifiers;
}

/** DOM deltas to RustDesk wire deltas: dominant axis, negated, ±1 per notch. */
export function wheelToMouseDelta(
  deltaX: number,
  deltaY: number,
): { x: number; y: number } {
  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    return { x: -Math.sign(deltaX), y: 0 };
  }
  if (deltaY !== 0) return { x: 0, y: -Math.sign(deltaY) };
  return { x: 0, y: 0 };
}

/**
 * Send one MouseEvent message, converting a closed relay/channel into a
 * `connection-lost` error. Shared by the mouse and touch encoders; host
 * callbacks must never throw back into DOM event handlers.
 */
export function sendMouseEvent(
  channel: MouseChannel,
  type: MouseMessageType,
  mask: number,
  x: number,
  y: number,
  modifiers: ControlKey[],
  onError?: (error: RustDeskError) => void,
): void {
  try {
    channel.sendMessage({ mouse_event: { mask, x, y, modifiers } });
  } catch (cause) {
    try {
      onError?.(
        new RustDeskError('connection-lost', `Failed to send mouse ${type}`, {
          cause,
        }),
      );
    } catch {
      // Host callbacks must not break input handling.
    }
  }
}

export class MouseInput {
  private readonly element: HTMLElement;
  private readonly mapper: RemoteCoordinateMapper;
  private readonly channel: MouseChannel;
  private readonly preventContextMenu: boolean;
  private readonly onError?: (error: RustDeskError) => void;
  private origin: { x: number; y: number };
  private enabledValue: boolean;
  private attached = false;
  /** RustDesk button bits currently held. */
  private buttons = 0;

  constructor(options: MouseInputOptions) {
    this.element = options.element;
    this.mapper = options.mapper;
    this.channel = options.channel;
    this.origin = normalizeOrigin(options.origin);
    this.enabledValue = options.enabled ?? true;
    this.preventContextMenu = options.preventContextMenu ?? true;
    this.onError = options.onError;
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabledValue) return;
    if (!enabled) this.releaseAll();
    this.enabledValue = enabled;
  }

  /** Update the origin after a display switch (P4-1 owns PeerInfo). */
  setOrigin(origin: { x: number; y: number }): void {
    this.origin = normalizeOrigin(origin);
  }

  attach(): void {
    if (this.attached || typeof window === 'undefined') return;
    this.element.addEventListener('mousedown', this.onMouseDown);
    this.element.addEventListener('mousemove', this.onHoverMove);
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    this.element.addEventListener('contextmenu', this.onContextMenu);
    this.element.addEventListener('auxclick', this.onAuxClick);
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    this.releaseAll();
    this.element.removeEventListener('mousedown', this.onMouseDown);
    this.element.removeEventListener('mousemove', this.onHoverMove);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    this.element.removeEventListener('auxclick', this.onAuxClick);
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.attached = false;
  }

  dispose(): void {
    this.detach();
    this.enabledValue = false;
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    const bit = domButtonBit(event.button);
    if (bit === null) return;
    event.preventDefault();
    if (!this.enabledValue) return;

    const position = mapClientPoint(
      this.mapper,
      this.element,
      event.clientX,
      event.clientY,
    );
    if (!position) return;
    // Down/up coordinates are ignored by the peer; move first so the click
    // lands where the local pointer is even if hover events were missed.
    this.sendMove(position, this.buttons);
    if (this.buttons & bit) return;
    this.buttons |= bit;
    this.send('down', mouseMask('down', bit), 0, 0, mouseModifiers(event));
  };

  private readonly onHoverMove = (event: MouseEvent): void => {
    if (!this.enabledValue || this.buttons !== 0) return;
    const position = mapClientPoint(
      this.mapper,
      this.element,
      event.clientX,
      event.clientY,
    );
    if (position) this.sendMove(position, 0);
  };

  private readonly onDragMove = (event: MouseEvent): void => {
    if (!this.enabledValue || this.buttons === 0) return;
    const position = mapClientPoint(
      this.mapper,
      this.element,
      event.clientX,
      event.clientY,
      true,
    );
    if (position) this.sendMove(position, this.buttons);
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    const bit = domButtonBit(event.button);
    if (bit === null || !(this.buttons & bit)) return;
    this.buttons &= ~bit;
    if (this.enabledValue) {
      this.send('up', mouseMask('up', bit), 0, 0, mouseModifiers(event));
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (!this.enabledValue || !this.mapper.layout) return;
    const delta = wheelToMouseDelta(event.deltaX, event.deltaY);
    if (delta.x === 0 && delta.y === 0) return;
    // Official clients send wheel events without modifiers.
    this.send('wheel', mouseMask('wheel'), delta.x, delta.y, []);
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.preventContextMenu) event.preventDefault();
  };

  private readonly onAuxClick = (event: MouseEvent): void => {
    // Middle-click autoscroll and back/forward navigation are local browser
    // defaults; the remote peer handles the button instead.
    event.preventDefault();
  };

  private readonly onBlur = (): void => {
    this.releaseAll();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.releaseAll();
    }
  };

  /** `buttonBits` is the unshifted RustDesk button mask (e.g. left = 1). */
  private sendMove(position: { x: number; y: number }, buttonBits: number): void {
    this.send(
      'move',
      mouseMask('move', buttonBits),
      this.origin.x + position.x,
      this.origin.y + position.y,
      [],
    );
  }

  private releaseAll(): void {
    const buttons = this.buttons;
    this.buttons = 0;
    for (const bit of Object.values(MOUSE_BUTTON)) {
      if (buttons & bit) {
        this.send('up', mouseMask('up', bit), 0, 0, []);
      }
    }
  }

  private send(
    type: MouseMessageType,
    mask: number,
    x: number,
    y: number,
    modifiers: ControlKey[],
  ): void {
    sendMouseEvent(this.channel, type, mask, x, y, modifiers, this.onError);
  }
}
