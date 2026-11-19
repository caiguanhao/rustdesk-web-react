import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MouseInput } from '../src/input/mouse';
import { ControlKey } from '../src/protocol/message';
import {
  FakeElement,
  dispatchDom,
  installFakeDom,
  type FakeDom,
} from './mocks/fake-dom';
import {
  connectMockRelay,
  type MockRelaySession,
} from './mocks/relay-session';
import { MockRustDeskServer, waitFor } from './mocks/rustdesk-mock';
import { MOUSE_RECT, remoteMapper } from './mocks/mouse-fixture';

// P3-1 integration: DOM mouse events → MouseInput → encrypted relay → mock
// controlled peer. A tiny EventTarget-based DOM keeps this in Node so
// libsodium (used by the real relay stack) sees same-realm Uint8Arrays; the
// jsdom unit test covers the DOM semantics. Real-device accuracy remains
// ⏳ 真机待验 in plan.

let dom: FakeDom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  dom.restore();
});

describe('mouse input over the mock relay', () => {
  it('delivers mask/coordinates/modifiers/wheel to the controlled peer', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    let relay: MockRelaySession | undefined;
    let mouse: MouseInput | undefined;
    try {
      relay = await connectMockRelay(mock);

      const canvas = new FakeElement(MOUSE_RECT);
      mouse = new MouseInput({
        element: canvas as unknown as HTMLElement,
        mapper: remoteMapper(),
        channel: relay.connection,
      });
      mouse.attach();

      dispatchDom(canvas, 'mousedown', {
        button: 0,
        buttons: 1,
        clientX: 260,
        clientY: 140,
        ctrlKey: true,
      });
      dispatchDom(dom.window, 'mousemove', {
        buttons: 1,
        clientX: 360,
        clientY: 190,
      });
      dispatchDom(dom.window, 'mouseup', {
        button: 0,
        buttons: 0,
        clientX: 360,
        clientY: 190,
      });
      dispatchDom(canvas, 'wheel', { deltaY: 120 });

      await waitFor(
        () => mock.inputs.filter((message) => message.mouse_event).length === 5,
        2000,
      );
      const events = mock.inputs
        .map((message) => message.mouse_event)
        .filter((event) => event !== undefined);
      expect(events).toMatchObject([
        { mask: 0, x: 320, y: 180 },
        {
          mask: 9,
          x: 0,
          y: 0,
          modifiers: [ControlKey.Control],
        },
        { mask: 8, x: 520, y: 280 },
        { mask: 10, x: 0, y: 0 },
        { mask: 3, x: 0, y: -1 },
      ]);
    } finally {
      mouse?.detach();
      relay?.close();
      await mock.close();
    }
  });
});
