import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { MouseInput } from '../src/input/mouse';
import { connectRelay, type RelayConnection } from '../src/protocol/connection';
import { LoginFlow } from '../src/protocol/login';
import { ControlKey } from '../src/protocol/message';
import type { WebSocketLike } from '../src/protocol/websock';
import { MockRustDeskServer, waitFor } from './mocks/rustdesk-mock';
import { MOUSE_RECT, remoteMapper } from './mocks/mouse-fixture';

// P3-1 integration: DOM mouse events → MouseInput → encrypted relay → mock
// controlled peer. A tiny EventTarget-based DOM keeps this in Node so
// libsodium (used by the real relay stack) sees same-realm Uint8Arrays; the
// jsdom unit test covers the DOM semantics. Real-device accuracy remains
// ⏳ 真机待验 in plan.

const createSocket = (url: string): WebSocketLike =>
  new WsClient(url) as unknown as WebSocketLike;

interface MouseInit {
  clientX?: number;
  clientY?: number;
  button?: number;
  buttons?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  deltaX?: number;
  deltaY?: number;
}

class FakeElement extends EventTarget {
  getBoundingClientRect(): DOMRect {
    return MOUSE_RECT;
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

let fakeWindow: EventTarget;
let fakeDocument: FakeDocument;

beforeEach(() => {
  fakeWindow = new EventTarget();
  fakeDocument = new FakeDocument();
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('document', fakeDocument);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function dispatch(target: EventTarget, type: string, init: MouseInit = {}): void {
  target.dispatchEvent(
    Object.assign(new Event(type, { bubbles: true, cancelable: true }), init),
  );
}

describe('mouse input over the mock relay', () => {
  it('delivers mask/coordinates/modifiers/wheel to the controlled peer', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    let connection: RelayConnection | undefined;
    let flow: LoginFlow | undefined;
    let mouse: MouseInput | undefined;
    try {
      connection = await connectRelay({
        server: mock.server,
        secure: false,
        peerId: mock.peerId,
        serverKey: mock.serverKey,
        openTimeoutMs: 1000,
        responseTimeoutMs: 1000,
        securingTimeoutMs: 2000,
        createSocket,
      });
      flow = new LoginFlow(connection, {
        peerId: mock.peerId,
        password: mock.password,
        loginTimeoutMs: 2000,
      });
      await flow.start();

      const canvas = new FakeElement();
      mouse = new MouseInput({
        element: canvas as unknown as HTMLElement,
        mapper: remoteMapper(),
        channel: connection,
      });
      mouse.attach();

      dispatch(canvas, 'mousedown', {
        button: 0,
        buttons: 1,
        clientX: 260,
        clientY: 140,
        ctrlKey: true,
      });
      dispatch(fakeWindow, 'mousemove', {
        buttons: 1,
        clientX: 360,
        clientY: 190,
      });
      dispatch(fakeWindow, 'mouseup', {
        button: 0,
        buttons: 0,
        clientX: 360,
        clientY: 190,
      });
      dispatch(canvas, 'wheel', { deltaY: 120 });

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
      flow?.dispose();
      connection?.close();
      await mock.close();
    }
  });
});
