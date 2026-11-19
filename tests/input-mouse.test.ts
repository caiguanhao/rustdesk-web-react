// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOUSE_BUTTON,
  MouseInput,
  domButtonBit,
  mouseMask,
  mouseModifiers,
  wheelToMouseDelta,
  type MouseChannel,
  type MouseInputOptions,
} from '../src/input/mouse';
import type { DeepPartial, Message } from '../src/protocol/message';
import { ControlKey } from '../src/protocol/message';
import { RustDeskError } from '../src/session/errors';
import {
  MOUSE_LAYOUT,
  MOUSE_RECT,
  remoteMapper,
} from './mocks/mouse-fixture';

// P3-1 unit coverage: wire masks, modifiers, wheel sign, button state,
// drag/edge clamping, context-menu and auxclick suppression, enable/disable,
// blur/visibility release, attach/detach cleanup and send errors. The real
// browser/relay behavior is covered by the mock-server integration and
// Playwright input tests.

interface SentMouse {
  mask: number;
  x: number;
  y: number;
  modifiers: ControlKey[];
}

function fakeChannel(
  forward?: MouseChannel,
): MouseChannel & { sent: SentMouse[] } {
  const sent: SentMouse[] = [];
  return {
    sent,
    sendMessage(payload: DeepPartial<Message>) {
      const event = payload.mouse_event;
      if (event) {
        sent.push({
          mask: event.mask ?? 0,
          x: event.x ?? 0,
          y: event.y ?? 0,
          modifiers: [...(event.modifiers ?? [])],
        });
      }
      forward?.sendMessage(payload);
    },
  };
}

let canvas: HTMLCanvasElement;
const inputs: MouseInput[] = [];

beforeEach(() => {
  canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => MOUSE_RECT;
  document.body.append(canvas);
});

afterEach(() => {
  for (const input of inputs.splice(0)) input.detach();
  document.body.innerHTML = '';
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

function makeInput(
  options: Partial<Omit<MouseInputOptions, 'element' | 'channel'>> = {},
  forward?: MouseChannel,
): { input: MouseInput; channel: ReturnType<typeof fakeChannel> } {
  const channel = fakeChannel(forward);
  const input = new MouseInput({
    element: canvas,
    mapper: remoteMapper(),
    channel,
    ...options,
  });
  inputs.push(input);
  return { input, channel };
}

function dispatchMouse(
  type: string,
  init: MouseEventInit = {},
  target: EventTarget = canvas,
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 260,
    clientY: 140,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function dispatchWheel(
  init: WheelEventInit = {},
  target: EventTarget = canvas,
): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY: 120,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe('mouse mask helpers', () => {
  it('encodes action and button bits', () => {
    expect(mouseMask('move')).toBe(0);
    expect(mouseMask('move', MOUSE_BUTTON.left)).toBe(8);
    expect(mouseMask('down', MOUSE_BUTTON.left)).toBe(9);
    expect(mouseMask('up', MOUSE_BUTTON.left)).toBe(10);
    expect(mouseMask('down', MOUSE_BUTTON.right)).toBe(17);
    expect(mouseMask('up', MOUSE_BUTTON.right)).toBe(18);
    expect(mouseMask('down', MOUSE_BUTTON.middle)).toBe(33);
    expect(mouseMask('up', MOUSE_BUTTON.middle)).toBe(34);
    expect(mouseMask('down', MOUSE_BUTTON.back)).toBe(65);
    expect(mouseMask('up', MOUSE_BUTTON.forward)).toBe(130);
    expect(mouseMask('wheel')).toBe(3);
  });

  it('maps DOM buttons and modifiers', () => {
    expect([0, 1, 2, 3, 4, 5].map(domButtonBit)).toEqual([
      MOUSE_BUTTON.left,
      MOUSE_BUTTON.middle,
      MOUSE_BUTTON.right,
      MOUSE_BUTTON.back,
      MOUSE_BUTTON.forward,
      null,
    ]);
    expect(
      mouseModifiers({
        altKey: true,
        ctrlKey: true,
        shiftKey: true,
        metaKey: true,
      }),
    ).toEqual([
      ControlKey.Alt,
      ControlKey.Control,
      ControlKey.Shift,
      ControlKey.Meta,
    ]);
    expect(
      mouseModifiers({ altKey: false, ctrlKey: false, shiftKey: false, metaKey: false }),
    ).toEqual([]);
  });

  it('negates the dominant DOM wheel axis and emits one notch', () => {
    expect(wheelToMouseDelta(0, 120)).toEqual({ x: 0, y: -1 });
    expect(wheelToMouseDelta(0, -120)).toEqual({ x: 0, y: 1 });
    expect(wheelToMouseDelta(120, 0)).toEqual({ x: -1, y: 0 });
    expect(wheelToMouseDelta(-120, 0)).toEqual({ x: 1, y: 0 });
    expect(wheelToMouseDelta(5, 10)).toEqual({ x: 0, y: -1 });
    expect(wheelToMouseDelta(10, 5)).toEqual({ x: -1, y: 0 });
    expect(wheelToMouseDelta(0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('MouseInput', () => {
  it('sends a move before down, then coordinates/down/up with modifiers', () => {
    const { input, channel } = makeInput();
    input.attach();

    dispatchMouse('mousedown', { button: 0, buttons: 1, ctrlKey: true });
    expect(channel.sent).toEqual([
      { mask: 0, x: 320, y: 180, modifiers: [] },
      { mask: 9, x: 0, y: 0, modifiers: [ControlKey.Control] },
    ]);

    // The canvas handler skips held moves; the window drag handler sends one.
    dispatchMouse('mousemove', { buttons: 1, clientX: 360, clientY: 190 });
    expect(channel.sent[2]).toEqual({ mask: 8, x: 520, y: 280, modifiers: [] });

    dispatchMouse(
      'mouseup',
      { button: 0, buttons: 0, clientX: 360, clientY: 190 },
      window,
    );
    expect(channel.sent[3]).toEqual({ mask: 10, x: 0, y: 0, modifiers: [] });

    // A second up for the same button is ignored.
    dispatchMouse('mouseup', { button: 0, buttons: 0 }, window);
    expect(channel.sent).toHaveLength(4);
  });

  it.each([
    { button: 1, down: 33, up: 34 },
    { button: 2, down: 17, up: 18 },
    { button: 3, down: 65, up: 66 },
    { button: 4, down: 129, up: 130 },
  ])('encodes button $button as $down/$up', ({ button, down, up }) => {
    const { input, channel } = makeInput();
    input.attach();
    dispatchMouse('mousedown', { button, buttons: 1 << button });
    expect(channel.sent.at(-1)?.mask).toBe(down);
    dispatchMouse('mouseup', { button, buttons: 0 }, window);
    expect(channel.sent.at(-1)?.mask).toBe(up);
  });

  it('rounds and clamps frame coordinates to the display', () => {
    const mapper = remoteMapper({
      toRemote: () => ({ x: MOUSE_LAYOUT.width - 0.4, y: -0.6 }),
    });
    const { input, channel } = makeInput({ mapper });
    input.attach();
    dispatchMouse('mousemove', { buttons: 0 });
    expect(channel.sent).toEqual([
      { mask: 0, x: MOUSE_LAYOUT.width - 1, y: 0, modifiers: [] },
    ]);
  });

  it('adds the current display origin and updates it', () => {
    const { input, channel } = makeInput({ origin: { x: 1920, y: 1080 } });
    input.attach();
    dispatchMouse('mousemove', { buttons: 0, clientX: 260, clientY: 140 });
    expect(channel.sent.at(-1)).toMatchObject({ x: 2240, y: 1260 });

    input.setOrigin({ x: -1920, y: 0 });
    dispatchMouse('mousemove', { buttons: 0, clientX: 260, clientY: 140 });
    expect(channel.sent.at(-1)).toMatchObject({ x: -1600, y: 180 });
  });

  it('clamps drag moves to the edge when the pointer leaves the canvas', () => {
    const { input, channel } = makeInput();
    input.attach();
    dispatchMouse('mousedown', { button: 0, buttons: 1 });
    dispatchMouse(
      'mousemove',
      { buttons: 1, clientX: 1000, clientY: 1000 },
      window,
    );
    expect(channel.sent.at(-1)).toEqual({
      mask: 8,
      x: MOUSE_LAYOUT.width - 1,
      y: MOUSE_LAYOUT.height - 1,
      modifiers: [],
    });
    dispatchMouse('mouseup', { button: 0, buttons: 0, clientX: 1000 }, window);
    expect(channel.sent.at(-1)?.mask).toBe(10);
  });

  it('sends sign-normalized wheel deltas and prevents the page scroll', () => {
    const { input, channel } = makeInput();
    input.attach();

    const down = dispatchWheel({ deltaY: 120 });
    expect(down.defaultPrevented).toBe(true);
    expect(channel.sent.at(-1)).toEqual({ mask: 3, x: 0, y: -1, modifiers: [] });

    dispatchWheel({ deltaY: -120 });
    expect(channel.sent.at(-1)).toEqual({ mask: 3, x: 0, y: 1, modifiers: [] });

    dispatchWheel({ deltaX: 120, deltaY: 0 });
    expect(channel.sent.at(-1)).toEqual({ mask: 3, x: -1, y: 0, modifiers: [] });

    dispatchWheel({ deltaX: 0, deltaY: 0 });
    expect(channel.sent).toHaveLength(3);
  });

  it('suppresses the local context menu and auxclick defaults', () => {
    const { input } = makeInput();
    input.attach();
    expect(dispatchMouse('contextmenu', { button: 2 }).defaultPrevented).toBe(true);
    expect(dispatchMouse('auxclick', { button: 1 }).defaultPrevented).toBe(true);
    expect(dispatchMouse('auxclick', { button: 3 }).defaultPrevented).toBe(true);
  });

  it('can leave the context menu to the host', () => {
    const { input } = makeInput({ preventContextMenu: false });
    input.attach();
    expect(dispatchMouse('contextmenu', { button: 2 }).defaultPrevented).toBe(false);
  });

  it('treats a double click as two down/up pairs', () => {
    const { input, channel } = makeInput();
    input.attach();
    for (let index = 0; index < 2; index += 1) {
      dispatchMouse('mousedown', { button: 0, buttons: 1 });
      dispatchMouse('mouseup', { button: 0, buttons: 0 }, window);
    }
    const masks = channel.sent.map((event) => event.mask);
    expect(masks.filter((mask) => mask === 9)).toHaveLength(2);
    expect(masks.filter((mask) => mask === 10)).toHaveLength(2);
  });

  it('releases held buttons on blur and when the page becomes hidden', () => {
    const { input, channel } = makeInput();
    input.attach();
    dispatchMouse('mousedown', { button: 0, buttons: 1 });
    dispatchMouse('mousedown', { button: 2, buttons: 3 });
    window.dispatchEvent(new Event('blur'));
    expect(channel.sent.slice(-2).map((event) => event.mask)).toEqual([10, 18]);

    dispatchMouse('mousedown', { button: 0, buttons: 1 });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(channel.sent.at(-1)?.mask).toBe(10);
  });

  it('disables sends, releases held buttons and re-enables', () => {
    const { input, channel } = makeInput({ enabled: false });
    input.attach();
    dispatchMouse('mousedown', { button: 0, buttons: 1 });
    dispatchWheel();
    expect(channel.sent).toEqual([]);

    input.setEnabled(true);
    dispatchMouse('mousedown', { button: 0, buttons: 1 });
    expect(channel.sent.at(-1)?.mask).toBe(9);
    input.setEnabled(false);
    expect(channel.sent.at(-1)?.mask).toBe(10);

    const count = channel.sent.length;
    dispatchMouse('mousemove', { buttons: 0 });
    dispatchMouse('mousedown', { button: 0, buttons: 1 });
    expect(channel.sent).toHaveLength(count);
  });

  it('attaches idempotently and detaches cleanly', () => {
    const { input, channel } = makeInput();
    const add = vi.spyOn(canvas, 'addEventListener');
    input.attach();
    input.attach();
    expect(add.mock.calls.filter(([type]) => type === 'wheel')).toHaveLength(1);
    const wheelOptions = add.mock.calls.find(([type]) => type === 'wheel')?.[2];
    expect(wheelOptions).toMatchObject({ passive: false });

    dispatchMouse('mousedown', { button: 0, buttons: 1 });
    expect(channel.sent.at(-1)?.mask).toBe(9);
    input.detach();
    expect(channel.sent.at(-1)?.mask).toBe(10);
    const count = channel.sent.length;
    dispatchMouse('mousedown', { button: 0, buttons: 1 });
    dispatchWheel();
    expect(channel.sent).toHaveLength(count);
  });

  it('ignores input without a layout or outside the canvas', () => {
    const noLayout = makeInput({
      mapper: { ...remoteMapper(), layout: null },
    });
    noLayout.input.attach();
    dispatchMouse('mousedown', { button: 0, buttons: 1 });
    dispatchWheel();
    expect(noLayout.channel.sent).toEqual([]);

    const { input, channel } = makeInput();
    input.attach();
    dispatchMouse('mousemove', { buttons: 0, clientX: 10, clientY: 10 });
    expect(channel.sent).toEqual([]);
  });

  it('reports send failures without throwing from DOM handlers', () => {
    const errors: RustDeskError[] = [];
    const channel: MouseChannel = {
      sendMessage() {
        throw new Error('relay closed');
      },
    };
    const { input } = makeInput(
      { onError: (error) => errors.push(error) },
      channel,
    );
    input.attach();
    expect(() => dispatchMouse('mousedown', { button: 0, buttons: 1 })).not.toThrow();
    expect(errors.map((error) => error.code)).toEqual([
      'connection-lost',
      'connection-lost',
    ]);
  });
});
