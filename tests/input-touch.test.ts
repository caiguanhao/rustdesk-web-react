// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TouchInput,
  type LocalZoomState,
  type TouchGesture,
  type TouchInputOptions,
} from '../src/input/touch';
import type { MouseChannel } from '../src/input/mouse';
import type { DeepPartial, Message, MouseEvent } from '../src/protocol/message';
import { RustDeskError } from '../src/session/errors';
import { MOUSE_RECT, remoteMapper } from './mocks/mouse-fixture';

// P3-4 unit coverage: tap/double-tap/long-press/drag/two-finger scroll/pinch,
// pointer filtering, cancel/disable/detach release, local zoom and errors.
// Real iPhone/Android behavior remains ⏳ 真机待验.

function fakeChannel(
  forward?: MouseChannel,
): MouseChannel & { sent: MouseEvent[] } {
  const sent: MouseEvent[] = [];
  return {
    sent,
    sendMessage(payload: DeepPartial<Message>) {
      if (payload.mouse_event) sent.push(payload.mouse_event as MouseEvent);
      forward?.sendMessage(payload);
    },
  };
}

let canvas: HTMLCanvasElement;
const inputs: TouchInput[] = [];

beforeEach(() => {
  canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => MOUSE_RECT;
  canvas.style.transform = 'translate(1px, 2px)';
  canvas.style.transformOrigin = 'center';
  document.body.append(canvas);
});

afterEach(() => {
  for (const input of inputs.splice(0)) input.dispose();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function makeInput(
  options: Partial<Omit<TouchInputOptions, 'element' | 'channel' | 'mapper'>> = {},
  channel: ReturnType<typeof fakeChannel> = fakeChannel(),
): { input: TouchInput; channel: ReturnType<typeof fakeChannel> } {
  const input = new TouchInput({
    element: canvas,
    mapper: remoteMapper(),
    channel,
    longPressMs: 50,
    ...options,
  });
  inputs.push(input);
  input.attach();
  return { input, channel };
}

function pointer(
  type: string,
  id: number,
  clientX: number,
  clientY: number,
  pointerType = 'touch',
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: id,
    pointerType,
    isPrimary: id === 1,
    clientX,
    clientY,
  });
}

function down(id: number, x = 260, y = 140): void {
  canvas.dispatchEvent(pointer('pointerdown', id, x, y));
}

function move(id: number, x: number, y: number): void {
  window.dispatchEvent(pointer('pointermove', id, x, y));
}

function up(id: number, x = 260, y = 140): void {
  window.dispatchEvent(pointer('pointerup', id, x, y));
}

const masks = (sent: MouseEvent[]): number[] => sent.map((event) => event.mask);

describe('TouchInput', () => {
  it('turns a tap into move + left down/up', () => {
    const gestures: TouchGesture[] = [];
    const { channel } = makeInput({
      onGesture: (gesture) => gestures.push(gesture),
    });
    down(1);
    up(1);
    expect(masks(channel.sent).slice(-3)).toEqual([0, 9, 10]);
    expect(channel.sent.at(-3)).toMatchObject({ x: 320, y: 180 });
    expect(gestures).toEqual(['tap']);
  });

  it('emits tap and double-tap gestures while sending two click pairs', () => {
    const gestures: TouchGesture[] = [];
    let now = 1_000;
    const { channel } = makeInput({
      now: () => now,
      onGesture: (gesture) => gestures.push(gesture),
    });
    down(1);
    up(1);
    now += 100;
    down(1);
    up(1);
    expect(gestures).toEqual(['tap', 'double-tap']);
    expect(masks(channel.sent).filter((mask) => mask === 9)).toHaveLength(2);
    expect(masks(channel.sent).filter((mask) => mask === 10)).toHaveLength(2);
  });

  it('measures double-tap distance in CSS pixels, not frame pixels', () => {
    const gestures: TouchGesture[] = [];
    let now = 1_000;
    makeInput({
      now: () => now,
      onGesture: (gesture) => gestures.push(gesture),
    });
    down(1, 200, 150);
    up(1, 200, 150);
    now += 100;
    // 20 CSS px apart = 40 frame px with the 0.5-scale mapper.
    down(1, 220, 150);
    up(1, 220, 150);
    expect(gestures).toEqual(['tap', 'double-tap']);
  });

  it('sends a right click after a long press', () => {
    vi.useFakeTimers();
    const gestures: TouchGesture[] = [];
    const { channel } = makeInput({
      onGesture: (gesture) => gestures.push(gesture),
    });
    down(1);
    vi.advanceTimersByTime(50);
    expect(masks(channel.sent).slice(-2)).toEqual([17, 18]);
    up(1);
    expect(masks(channel.sent).filter((mask) => mask === 9)).toEqual([]);
    expect(gestures).toEqual(['long-press']);
  });

  it('cancels long press on movement and starts a left drag', () => {
    vi.useFakeTimers();
    const { channel } = makeInput();
    down(1);
    move(1, 300, 140);
    vi.advanceTimersByTime(50);
    expect(masks(channel.sent)).not.toContain(17);
    expect(masks(channel.sent)).toContain(9);
    move(1, 320, 140);
    up(1, 320, 140);
    expect(masks(channel.sent).slice(-1)).toEqual([10]);
    const downIndex = masks(channel.sent).indexOf(9);
    expect(masks(channel.sent).slice(downIndex + 1, -1).every((mask) => mask === 8)).toBe(
      true,
    );
  });

  it('moves the cursor without pressing in mouse mode', () => {
    const { channel } = makeInput({ mode: 'mouse' });
    down(1);
    move(1, 320, 160);
    up(1, 320, 160);
    expect(masks(channel.sent)).toEqual([0, 0]);
    expect(masks(channel.sent)).not.toContain(9);
  });

  it('sends wheel events from a two-finger scroll', () => {
    const { channel } = makeInput({ pinchSlop: 1_000 });
    down(1, 200, 150);
    down(2, 220, 150);
    channel.sent.length = 0;
    move(1, 200, 190);
    move(2, 220, 190);
    expect(channel.sent.at(-1)).toMatchObject({ mask: 3, x: 0, y: -1 });
    expect(channel.sent.every((event) => event.mask === 3)).toBe(true);
  });

  it('does not latch pinch when one finger leads a two-finger scroll', () => {
    const gestures: TouchGesture[] = [];
    const { channel } = makeInput({
      onGesture: (gesture) => gestures.push(gesture),
    });
    down(1, 200, 150);
    down(2, 220, 150);
    // The first finger moves 28 px down before the second one follows, so
    // the span grows even though the gesture is an ordinary scroll.
    move(1, 200, 178);
    expect(gestures).toEqual([]);
    move(2, 220, 178);
    expect(gestures).toEqual(['scroll']);
    expect(channel.sent.at(-1)).toMatchObject({ mask: 3, x: 0, y: -1 });
  });

  it('zooms locally on pinch without sending remote input', () => {
    const zooms: LocalZoomState[] = [];
    const gestures: TouchGesture[] = [];
    const { input, channel } = makeInput({
      onLocalZoom: (state) => zooms.push(state),
      onGesture: (gesture) => gestures.push(gesture),
    });
    down(1, 200, 150);
    down(2, 300, 150);
    channel.sent.length = 0;
    move(1, 150, 150);
    move(2, 350, 150);
    expect(channel.sent).toEqual([]);
    expect(gestures).toContain('pinch');
    expect(zooms.at(-1)?.scale).toBeGreaterThan(1);
    expect(canvas.style.transform).toContain('scale(');
    expect(canvas.style.transformOrigin).toMatch(/^0(px)? 0(px)?$/);

    input.resetLocalZoom();
    expect(input.localZoom).toEqual({ scale: 1, translateX: 0, translateY: 0 });
    expect(canvas.style.transform).toBe('translate(1px, 2px)');
  });

  it('releases a drag button when a second finger starts a multi gesture', () => {
    const { channel } = makeInput({ pinchSlop: 1_000 });
    down(1, 200, 150);
    move(1, 260, 150);
    expect(masks(channel.sent).slice(-2)).toEqual([9, 8]);
    down(2, 300, 150);
    expect(masks(channel.sent).at(-1)).toBe(10);
    up(1, 260, 150);
    up(2, 300, 150);
    expect(masks(channel.sent).filter((mask) => mask === 10)).toHaveLength(1);
  });

  it('does not promote a remaining finger after a multi gesture', () => {
    const { channel } = makeInput();
    down(1, 200, 150);
    down(2, 300, 150);
    channel.sent.length = 0;
    up(2, 300, 150);
    up(1, 200, 150);
    expect(channel.sent).toEqual([]);
  });

  it('releases held buttons on pointercancel, blur, hidden, disable and detach', () => {
    const triggers: Array<[string, (input: TouchInput) => void]> = [
      [
        'pointercancel',
        () =>
          window.dispatchEvent(pointer('pointercancel', 1, 300, 140)),
      ],
      ['blur', () => window.dispatchEvent(new Event('blur'))],
      [
        'hidden',
        () => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
          });
          document.dispatchEvent(new Event('visibilitychange'));
          delete (document as unknown as Record<string, unknown>)
            .visibilityState;
        },
      ],
      ['disable', (input) => input.setEnabled(false)],
      ['detach', (input) => input.detach()],
    ];
    for (const [name, trigger] of triggers) {
      const { input, channel } = makeInput();
      down(1);
      move(1, 300, 140);
      trigger(input);
      expect(masks(channel.sent).at(-1), name).toBe(10);
      input.dispose();
    }
  });

  it('sets touch-action none and restores inline styles on detach', () => {
    const { input } = makeInput();
    expect(canvas.style.touchAction).toBe('none');
    input.detach();
    expect(canvas.style.touchAction).toBe('');
    expect(canvas.style.transform).toBe('translate(1px, 2px)');
    expect(canvas.style.transformOrigin).toBe('center');
  });

  it('prevents defaults only while enabled and ignores mouse pointers', () => {
    const { input, channel } = makeInput();
    const mouseDown = pointer('pointerdown', 1, 260, 140, 'mouse');
    canvas.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(false);
    expect(channel.sent).toEqual([]);

    const touchDown = pointer('pointerdown', 2, 260, 140, 'touch');
    canvas.dispatchEvent(touchDown);
    expect(touchDown.defaultPrevented).toBe(true);
    up(2);

    input.setEnabled(false);
    const disabledDown = pointer('pointerdown', 3, 260, 140, 'touch');
    canvas.dispatchEvent(disabledDown);
    expect(disabledDown.defaultPrevented).toBe(false);
  });

  it('ignores touches outside the mapped canvas and adds origin', () => {
    const { channel } = makeInput({ origin: { x: 1920, y: 1080 } });
    down(1, 10, 10);
    up(1, 10, 10);
    expect(channel.sent).toEqual([]);

    down(1, 260, 140);
    up(1, 260, 140);
    expect(channel.sent[0]).toMatchObject({ x: 2240, y: 1260 });
  });

  it('reports send failures without throwing from pointer handlers', () => {
    const errors: RustDeskError[] = [];
    const channel = fakeChannel({
      sendMessage() {
        throw new Error('relay closed');
      },
    });
    makeInput({ onError: (error) => errors.push(error) }, channel);
    expect(() => {
      down(1);
      up(1);
    }).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((error) => error.code === 'connection-lost')).toBe(true);
  });
});
