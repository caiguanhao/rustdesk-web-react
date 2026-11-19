import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TouchInput } from '../src/input/touch';
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

// P3-4 integration: touch pointer gestures → mouse emulation → encrypted
// relay → mock peer. Real iPhone/Android behavior remains ⏳ 真机待验.

let dom: FakeDom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  dom.restore();
});

function pointer(id: number, clientX: number, clientY: number): object {
  return {
    pointerId: id,
    pointerType: 'touch',
    isPrimary: id === 1,
    clientX,
    clientY,
  };
}

describe('touch input over the mock relay', () => {
  it('sends tap, drag and two-finger scroll through the peer', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    let relay: MockRelaySession | undefined;
    let touch: TouchInput | undefined;
    try {
      relay = await connectMockRelay(mock);
      const canvas = new FakeElement(MOUSE_RECT);
      touch = new TouchInput({
        element: canvas as unknown as HTMLElement,
        mapper: remoteMapper(),
        channel: relay.connection,
        pinchSlop: 1_000,
      });
      touch.attach();

      const mouseEvents = () =>
        mock.inputs.flatMap((message) =>
          message.mouse_event ? [message.mouse_event] : [],
        );

      dispatchDom(canvas, 'pointerdown', pointer(1, 260, 140));
      dispatchDom(dom.window, 'pointerup', pointer(1, 260, 140));
      await waitFor(() => mouseEvents().length >= 3, 2000);
      expect(mouseEvents().map((event) => event.mask)).toEqual([0, 9, 10]);

      dispatchDom(canvas, 'pointerdown', pointer(1, 200, 150));
      dispatchDom(dom.window, 'pointermove', pointer(1, 260, 150));
      dispatchDom(dom.window, 'pointermove', pointer(1, 280, 150));
      dispatchDom(dom.window, 'pointerup', pointer(1, 280, 150));
      await waitFor(() => mouseEvents().length >= 8, 2000);
      expect(mouseEvents().slice(3).map((event) => event.mask)).toEqual([
        0, 9, 8, 8, 10,
      ]);

      dispatchDom(canvas, 'pointerdown', pointer(1, 200, 150));
      dispatchDom(canvas, 'pointerdown', pointer(2, 220, 150));
      dispatchDom(dom.window, 'pointermove', pointer(1, 200, 190));
      dispatchDom(dom.window, 'pointermove', pointer(2, 220, 190));
      dispatchDom(dom.window, 'pointerup', pointer(1, 200, 190));
      dispatchDom(dom.window, 'pointerup', pointer(2, 220, 190));
      await waitFor(() => mouseEvents().length >= 9, 2000);
      expect(mouseEvents().at(-1)).toMatchObject({ mask: 3, x: 0, y: -1 });
    } finally {
      touch?.dispose();
      relay?.close();
      await mock.close();
    }
  });
});
