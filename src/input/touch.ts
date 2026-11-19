/**
 * Touch gestures → RustDesk mouse emulation (P3-4).
 *
 * Desktop peers receive MouseEvents only: tap = move + left down/up,
 * double-tap = two clicks (the peer OS detects the double click), long press
 * = right click, one-finger drag = left down/move/up, two-finger scroll =
 * wheel events. Pinch is local-only (canvas CSS transform) and sends nothing;
 * the default applies translate/scale to the element, with an
 * `onLocalZoom` callback for P4-3 to own the transform instead.
 *
 * Touch uses Pointer Events and ignores pointerType "mouse", so MouseInput
 * can stay attached for hybrid laptops. `preventDefault` on pointer/touch
 * start plus `touch-action:none` suppresses browser pan/zoom and synthetic
 * compatibility mouse events in Chromium. A controlled Android peer's
 * PointerDeviceEvent pan/scale protocol is not implemented in the vendored
 * codec; MVP targets desktop peers.
 *
 * Constants follow Flutter's gesture feel where practical: 500 ms long
 * press, 300 ms double-tap window and distance (both CSS px), 10 CSS px
 * tap/drag slop (no dead zone), 24 px per wheel notch and a 10 px movement
 * threshold for choosing pinch vs two-finger scroll. The choice compares
 * movement along the initial finger line (scale) against centroid movement
 * (scroll), so interleaved one-finger events in a normal two-finger scroll
 * do not latch pinch. These need real-device tuning (⏳ 真机待验).
 */
import type { RustDeskError } from '../session/errors.js';
import {
  mapClientPoint,
  type RemoteCoordinateMapper,
  type RemotePoint,
} from './coordinates.js';
import {
  MOUSE_BUTTON,
  mouseMask,
  normalizeOrigin,
  sendMouseEvent,
  wheelToMouseDelta,
  type MouseChannel,
  type MouseMessageType,
} from './mouse.js';

export type TouchMode = 'touch' | 'mouse';
export type TouchGesture =
  | 'tap'
  | 'double-tap'
  | 'long-press'
  | 'drag'
  | 'scroll'
  | 'pinch';

export interface LocalZoomState {
  scale: number;
  translateX: number;
  translateY: number;
}

export interface TouchInputOptions {
  /** Element receiving touch input (normally the video canvas). */
  element: HTMLElement;
  mapper: RemoteCoordinateMapper;
  channel: MouseChannel;
  /** Display origin from PeerInfo.displays[currentDisplay]. */
  origin?: { x: number; y: number };
  enabled?: boolean;
  /** "touch" presses the left button on drag; "mouse" only moves the cursor. */
  mode?: TouchMode;
  longPressMs?: number;
  tapSlop?: number;
  dragSlop?: number;
  doubleTapMs?: number;
  doubleTapSlop?: number;
  scrollStep?: number;
  pinchSlop?: number;
  minScale?: number;
  maxScale?: number;
  /** Call preventDefault on accepted pointer/touch starts; default true. */
  preventDefault?: boolean;
  preventContextMenu?: boolean;
  /** Set element.style.touchAction = "none" while attached; default true. */
  setTouchAction?: boolean;
  /** Apply the pinch transform to the element; default true. */
  applyLocalZoom?: boolean;
  onLocalZoom?: (state: LocalZoomState) => void;
  onGesture?: (gesture: TouchGesture) => void;
  onError?: (error: RustDeskError) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

type GestureState = 'idle' | 'single' | 'drag' | 'long' | 'multi' | 'suppress';

interface PointerPoint {
  x: number;
  y: number;
}

interface MultiState {
  /** Finger positions when the second finger landed. */
  start: readonly [PointerPoint, PointerPoint];
  distance0: number;
  centroid0: PointerPoint;
  lastCentroid: PointerPoint;
  mode: 'pending' | 'scroll' | 'pinch';
  zoom0: LocalZoomState;
  rect0: { left: number; top: number; width: number; height: number };
  scrollX: number;
  scrollY: number;
}

const DEFAULT_LONG_PRESS_MS = 500;
const DEFAULT_TAP_SLOP = 10;
const DEFAULT_DOUBLE_TAP_MS = 300;
const DEFAULT_DOUBLE_TAP_SLOP = 30;
const DEFAULT_SCROLL_STEP = 24;
const DEFAULT_PINCH_SLOP = 10;
const DEFAULT_MIN_SCALE = 1;
const DEFAULT_MAX_SCALE = 4;

const distanceBetween = (a: PointerPoint, b: PointerPoint): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const centroidOf = (a: PointerPoint, b: PointerPoint): PointerPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const isIdentity = (state: LocalZoomState): boolean =>
  state.scale === 1 && state.translateX === 0 && state.translateY === 0;

/** Absolute movement of the finger pair along its initial connecting line. */
const alongFingerLine = (
  start: readonly [PointerPoint, PointerPoint],
  current: readonly [PointerPoint, PointerPoint],
): number => {
  const axisX = start[1].x - start[0].x;
  const axisY = start[1].y - start[0].y;
  const axisLength = Math.hypot(axisX, axisY);
  if (axisLength === 0) return 0;
  return Math.abs(
    ((current[1].x - current[0].x - axisX) * axisX +
      (current[1].y - current[0].y - axisY) * axisY) /
      axisLength,
  );
};

export class TouchInput {
  private readonly element: HTMLElement;
  private readonly mapper: RemoteCoordinateMapper;
  private readonly channel: MouseChannel;
  private readonly mode: TouchMode;
  private readonly longPressMs: number;
  private readonly tapSlop: number;
  private readonly dragSlop: number;
  private readonly doubleTapMs: number;
  private readonly doubleTapSlop: number;
  private readonly scrollStep: number;
  private readonly pinchSlop: number;
  private readonly minScale: number;
  private readonly maxScale: number;
  private readonly preventDefaultValue: boolean;
  private readonly preventContextMenu: boolean;
  private readonly setTouchAction: boolean;
  private readonly applyLocalZoom: boolean;
  private readonly onLocalZoom?: (state: LocalZoomState) => void;
  private readonly onGesture?: (gesture: TouchGesture) => void;
  private readonly onError?: (error: RustDeskError) => void;
  private readonly now: () => number;
  private readonly pointers = new Map<number, PointerPoint>();
  private origin: { x: number; y: number };
  private enabledValue: boolean;
  private state: GestureState = 'idle';
  private startClient?: PointerPoint;
  private longPressTimer: ReturnType<typeof setTimeout> | undefined;
  private multi: MultiState | undefined;
  private zoom: LocalZoomState = { scale: 1, translateX: 0, translateY: 0 };
  private lastTapAt = Number.NEGATIVE_INFINITY;
  private lastTapPoint: PointerPoint | undefined;
  private savedStyle:
    | { transform: string; transformOrigin: string; touchAction: string }
    | undefined;

  constructor(options: TouchInputOptions) {
    this.element = options.element;
    this.mapper = options.mapper;
    this.channel = options.channel;
    this.mode = options.mode ?? 'touch';
    this.longPressMs = options.longPressMs ?? DEFAULT_LONG_PRESS_MS;
    this.tapSlop = options.tapSlop ?? DEFAULT_TAP_SLOP;
    this.dragSlop = options.dragSlop ?? this.tapSlop;
    this.doubleTapMs = options.doubleTapMs ?? DEFAULT_DOUBLE_TAP_MS;
    this.doubleTapSlop = options.doubleTapSlop ?? DEFAULT_DOUBLE_TAP_SLOP;
    this.scrollStep = options.scrollStep ?? DEFAULT_SCROLL_STEP;
    this.pinchSlop = options.pinchSlop ?? DEFAULT_PINCH_SLOP;
    this.minScale = options.minScale ?? DEFAULT_MIN_SCALE;
    this.maxScale = options.maxScale ?? DEFAULT_MAX_SCALE;
    this.preventDefaultValue = options.preventDefault ?? true;
    this.preventContextMenu = options.preventContextMenu ?? true;
    this.setTouchAction = options.setTouchAction ?? true;
    this.applyLocalZoom = options.applyLocalZoom ?? true;
    this.onLocalZoom = options.onLocalZoom;
    this.onGesture = options.onGesture;
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
    this.origin = normalizeOrigin(options.origin);
    this.enabledValue = options.enabled ?? true;
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  get localZoom(): LocalZoomState {
    return { ...this.zoom };
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabledValue) return;
    if (!enabled) this.cancelGesture();
    this.enabledValue = enabled;
  }

  setOrigin(origin: { x: number; y: number }): void {
    this.origin = normalizeOrigin(origin);
  }

  resetLocalZoom(): void {
    this.applyZoom({ scale: 1, translateX: 0, translateY: 0 });
  }

  attach(): void {
    if (this.savedStyle || typeof window === 'undefined') return;
    this.savedStyle = {
      transform: this.element.style.transform,
      transformOrigin: this.element.style.transformOrigin,
      touchAction: this.element.style.touchAction,
    };
    if (this.setTouchAction) this.element.style.touchAction = 'none';
    this.element.addEventListener('pointerdown', this.onPointerDown, {
      passive: false,
    });
    this.element.addEventListener('contextmenu', this.onContextMenu);
    this.element.addEventListener('lostpointercapture', this.onLostCapture);
    this.element.addEventListener('touchstart', this.onTouchDefault, {
      passive: false,
    });
    this.element.addEventListener('touchmove', this.onTouchDefault, {
      passive: false,
    });
    // Safari-only gesture events (not in the DOM typings).
    this.element.addEventListener('gesturestart', this.onTouchDefault, {
      passive: false,
    } as AddEventListenerOptions);
    this.element.addEventListener('gesturechange', this.onTouchDefault, {
      passive: false,
    } as AddEventListenerOptions);
    this.element.addEventListener('gestureend', this.onTouchDefault, {
      passive: false,
    } as AddEventListenerOptions);
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  detach(): void {
    if (!this.savedStyle) return;
    this.cancelGesture();
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    this.element.removeEventListener('lostpointercapture', this.onLostCapture);
    this.element.removeEventListener('touchstart', this.onTouchDefault);
    this.element.removeEventListener('touchmove', this.onTouchDefault);
    this.element.removeEventListener('gesturestart', this.onTouchDefault);
    this.element.removeEventListener('gesturechange', this.onTouchDefault);
    this.element.removeEventListener('gestureend', this.onTouchDefault);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.applyLocalZoom) {
      this.element.style.transform = this.savedStyle.transform;
      this.element.style.transformOrigin = this.savedStyle.transformOrigin;
    }
    this.element.style.touchAction = this.savedStyle.touchAction;
    this.savedStyle = undefined;
    this.zoom = { scale: 1, translateX: 0, translateY: 0 };
  }

  dispose(): void {
    this.detach();
    this.enabledValue = false;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabledValue || event.pointerType === 'mouse') return;
    if (this.preventDefaultValue) event.preventDefault();
    if (this.state === 'suppress' || this.pointers.size >= 2) return;

    const point = { x: event.clientX, y: event.clientY };
    const remote = mapClientPoint(
      this.mapper,
      this.element,
      point.x,
      point.y,
    );
    if (!remote) return;

    this.capture(event.pointerId);
    this.pointers.set(event.pointerId, point);

    if (this.pointers.size === 1) {
      // Copy: the pointer entry mutates on every move.
      this.startClient = { ...point };
      this.state = 'single';
      this.scheduleLongPress();
      return;
    }

    // Second finger: cancel single-finger timers/buttons, then pan/zoom.
    this.clearLongPress();
    this.releaseLeft();
    const points = [...this.pointers.values()] as [
      PointerPoint,
      PointerPoint,
    ];
    const [first, second] = points;
    const centroid0 = centroidOf(first, second);
    this.state = 'multi';
    this.multi = {
      start: [{ ...first }, { ...second }],
      distance0: Math.max(1, distanceBetween(first, second)),
      centroid0,
      lastCentroid: centroid0,
      mode: 'pending',
      zoom0: { ...this.zoom },
      rect0: this.rect(),
      scrollX: 0,
      scrollY: 0,
    };
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const point = this.pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
    if (!this.enabledValue || this.state === 'suppress' || this.state === 'long') {
      return;
    }

    if (this.state === 'single' && this.startClient) {
      const moved = distanceBetween(this.startClient, point);
      if (moved > this.tapSlop) this.clearLongPress();
      if (moved <= this.dragSlop) return;
      this.state = 'drag';
      const start = mapClientPoint(
        this.mapper,
        this.element,
        this.startClient.x,
        this.startClient.y,
      );
      if (start) this.sendMove(start);
      if (this.mode === 'touch') {
        this.sendButton('down', MOUSE_BUTTON.left);
      }
      this.emitGesture('drag');
    }

    if (this.state === 'drag') {
      const remote = mapClientPoint(
        this.mapper,
        this.element,
        point.x,
        point.y,
        true,
      );
      if (remote) {
        this.sendMove(
          remote,
          this.mode === 'touch' ? MOUSE_BUTTON.left : 0,
        );
      }
      return;
    }

    if (this.state === 'multi') this.updateMulti();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.delete(event.pointerId);
    this.releaseCapture(event.pointerId);

    if (this.state === 'suppress') {
      if (this.pointers.size === 0) this.state = 'idle';
      return;
    }

    if (this.state === 'single') {
      this.clearLongPress();
      const point = { x: event.clientX, y: event.clientY };
      const remote = mapClientPoint(
        this.mapper,
        this.element,
        point.x,
        point.y,
      );
      if (remote) {
        this.sendMove(remote);
        this.sendButton('down', MOUSE_BUTTON.left);
        this.sendButton('up', MOUSE_BUTTON.left);
        this.emitTap(point);
      }
      this.state = 'idle';
      return;
    }

    if (this.state === 'drag') {
      this.releaseLeft();
      this.state = 'idle';
      return;
    }

    if (this.state === 'long') {
      this.state = 'idle';
      return;
    }

    if (this.state === 'multi') {
      this.multi = undefined;
      // Do not promote the remaining finger to a tap/drag.
      this.state = this.pointers.size > 0 ? 'suppress' : 'idle';
    }
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.releaseCapture(event.pointerId);
    this.cancelGesture();
  };

  private readonly onLostCapture = (event: PointerEvent): void => {
    if (this.pointers.has(event.pointerId)) this.cancelGesture();
  };

  private readonly onContextMenu = (event: Event): void => {
    if (this.preventContextMenu) event.preventDefault();
  };

  private readonly onTouchDefault = (event: Event): void => {
    if (this.enabledValue && this.preventDefaultValue) event.preventDefault();
  };

  private readonly onBlur = (): void => {
    this.cancelGesture();
  };

  private readonly onPageHide = (): void => {
    this.cancelGesture();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.cancelGesture();
  };

  private scheduleLongPress(): void {
    this.clearLongPress();
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = undefined;
      this.fireLongPress();
    }, this.longPressMs);
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== undefined) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = undefined;
    }
  }

  private fireLongPress(): void {
    if (
      this.state !== 'single' ||
      !this.startClient ||
      this.pointers.size !== 1
    ) {
      return;
    }
    const point = [...this.pointers.values()][0]!;
    if (distanceBetween(this.startClient, point) > this.tapSlop) return;
    const remote = mapClientPoint(
      this.mapper,
      this.element,
      point.x,
      point.y,
    );
    if (!remote) return;
    this.sendMove(remote);
    this.sendButton('down', MOUSE_BUTTON.right);
    this.sendButton('up', MOUSE_BUTTON.right);
    this.state = 'long';
    this.emitGesture('long-press');
  }

  private updateMulti(): void {
    if (!this.multi) return;
    const points = [...this.pointers.values()];
    const first = points[0];
    const second = points[1];
    if (!first || !second) return;
    const distance = distanceBetween(first, second);
    const centroid = centroidOf(first, second);

    if (this.multi.mode === 'pending') {
      const { start, centroid0 } = this.multi;
      // Movement along the initial finger line changes the span (scale);
      // centroid movement moves the whole hand (scroll). Comparing the two
      // prevents a one-finger lead during an ordinary scroll from latching
      // pinch, without requiring the other finger to move at all.
      const along = alongFingerLine(start, [first, second]);
      const centroidDelta = distanceBetween(centroid, centroid0);
      if (along > this.pinchSlop && along > centroidDelta) {
        this.multi.mode = 'pinch';
        this.emitGesture('pinch');
      } else if (centroidDelta > this.scrollStep) {
        this.multi.mode = 'scroll';
        this.multi.lastCentroid = centroid0;
        this.emitGesture('scroll');
      }
    }

    if (this.multi.mode === 'pinch') {
      this.updatePinch(distance, centroid);
    } else if (this.multi.mode === 'scroll') {
      this.multi.scrollX += centroid.x - this.multi.lastCentroid.x;
      this.multi.scrollY += centroid.y - this.multi.lastCentroid.y;
      this.multi.lastCentroid = centroid;
      if (
        Math.abs(this.multi.scrollX) >= this.scrollStep ||
        Math.abs(this.multi.scrollY) >= this.scrollStep
      ) {
        const delta = wheelToMouseDelta(
          this.multi.scrollX,
          this.multi.scrollY,
        );
        if (delta.x !== 0 || delta.y !== 0) {
          this.send('wheel', mouseMask('wheel'), delta.x, delta.y);
        }
        this.multi.scrollX = 0;
        this.multi.scrollY = 0;
      }
    }
  }

  private updatePinch(distance: number, centroid: PointerPoint): void {
    if (!this.multi) return;
    const { distance0, zoom0, rect0, centroid0 } = this.multi;
    if (rect0.width <= 0 || rect0.height <= 0) return;
    const scale = clamp(
      zoom0.scale * (distance / distance0),
      this.minScale,
      this.maxScale,
    );
    if (scale <= 1.001) {
      this.applyZoom({ scale: 1, translateX: 0, translateY: 0 });
      return;
    }
    const newWidth = rect0.width * (scale / zoom0.scale);
    const newHeight = rect0.height * (scale / zoom0.scale);
    const u = (centroid0.x - rect0.left) / rect0.width;
    const v = (centroid0.y - rect0.top) / rect0.height;
    const newLeft = centroid.x - u * newWidth;
    const newTop = centroid.y - v * newHeight;
    this.applyZoom({
      scale,
      translateX: zoom0.translateX + (newLeft - rect0.left),
      translateY: zoom0.translateY + (newTop - rect0.top),
    });
  }

  private applyZoom(state: LocalZoomState): void {
    const previous = this.zoom;
    if (
      previous.scale === state.scale &&
      previous.translateX === state.translateX &&
      previous.translateY === state.translateY
    ) {
      return;
    }
    this.zoom = state;
    if (this.applyLocalZoom) {
      if (isIdentity(state)) {
        this.element.style.transform = this.savedStyle?.transform ?? '';
        this.element.style.transformOrigin =
          this.savedStyle?.transformOrigin ?? '';
      } else {
        if (isIdentity(previous)) this.element.style.transformOrigin = '0 0';
        this.element.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
      }
    }
    try {
      this.onLocalZoom?.({ ...state });
    } catch {
      // Host callbacks must not break gestures.
    }
  }

  private emitTap(point: PointerPoint): void {
    const now = this.now();
    const double =
      now - this.lastTapAt <= this.doubleTapMs &&
      this.lastTapPoint !== undefined &&
      distanceBetween(point, this.lastTapPoint) <= this.doubleTapSlop;
    this.emitGesture(double ? 'double-tap' : 'tap');
    this.lastTapAt = now;
    this.lastTapPoint = point;
  }

  private emitGesture(gesture: TouchGesture): void {
    try {
      this.onGesture?.(gesture);
    } catch {
      // Host callbacks must not break gestures.
    }
  }

  private cancelGesture(): void {
    this.clearLongPress();
    this.releaseLeft();
    this.pointers.clear();
    this.multi = undefined;
    this.state = 'idle';
    this.startClient = undefined;
    this.lastTapAt = Number.NEGATIVE_INFINITY;
    this.lastTapPoint = undefined;
  }

  private releaseLeft(): void {
    if (this.state !== 'drag' || this.mode !== 'touch') return;
    this.sendButton('up', MOUSE_BUTTON.left);
  }

  private sendMove(remote: RemotePoint, buttonBits = 0): void {
    this.send(
      'move',
      mouseMask('move', buttonBits),
      this.origin.x + remote.x,
      this.origin.y + remote.y,
    );
  }

  private sendButton(kind: 'down' | 'up', bit: number): void {
    this.send(kind, mouseMask(kind, bit), 0, 0);
  }

  private send(
    type: MouseMessageType,
    mask: number,
    x: number,
    y: number,
  ): void {
    sendMouseEvent(this.channel, type, mask, x, y, [], this.onError);
  }

  private rect(): { left: number; top: number; width: number; height: number } {
    const rect = this.element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  private capture(pointerId: number): void {
    const element = this.element as HTMLElement & {
      setPointerCapture?: (id: number) => void;
    };
    try {
      element.setPointerCapture?.(pointerId);
    } catch {
      // Not supported/active; window listeners still receive the events.
    }
  }

  private releaseCapture(pointerId: number): void {
    const element = this.element as HTMLElement & {
      releasePointerCapture?: (id: number) => void;
    };
    try {
      element.releasePointerCapture?.(pointerId);
    } catch {
      // Already released.
    }
  }
}
