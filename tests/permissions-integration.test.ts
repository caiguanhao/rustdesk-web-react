import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClipboardController } from '../src/input/clipboard';
import { KeyboardInput } from '../src/input/keyboard';
import { MouseInput } from '../src/input/mouse';
import { PermissionInfo_Permission } from '../src/protocol/message';
import { RustDeskError } from '../src/session/errors';
import { SessionPermissions } from '../src/session/permissions';
import {
  FakeElement,
  dispatchDom,
  installFakeDom,
  type FakeDom,
} from './mocks/fake-dom';
import { MOUSE_RECT, remoteMapper } from './mocks/mouse-fixture';
import {
  connectMockRelay,
  type MockRelaySession,
} from './mocks/relay-session';
import { MockRustDeskServer, waitFor } from './mocks/rustdesk-mock';

// P3-6 integration: post-login permission_info over the encrypted mock relay
// disables/releases real input controllers. The host gates mouse/touch/keys/IME
// on the keyboard permission, so revoking it must stop all of them. View-only
// is local and is applied through the same SessionPermissions instance.

let dom: FakeDom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  dom.restore();
});

function sendKey(type: 'keydown' | 'keyup', code: string): void {
  dispatchDom(dom.document, type, {
    code,
    key: code,
    keyCode: 0,
    isComposing: false,
    getModifierState: () => false,
  });
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 30));

describe('permissions over the mock relay', () => {
  it('releases held input and blocks sends when keyboard is revoked', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    let relay: MockRelaySession | undefined;
    let keyboard: KeyboardInput | undefined;
    let mouse: MouseInput | undefined;
    let clipboard: ClipboardController | undefined;
    try {
      relay = await connectMockRelay(mock);
      const canvas = new FakeElement(MOUSE_RECT);
      keyboard = new KeyboardInput({
        channel: relay.connection,
        platform: 'Windows',
      });
      mouse = new MouseInput({
        channel: relay.connection,
        element: canvas as unknown as HTMLElement,
        mapper: remoteMapper(),
      });
      clipboard = new ClipboardController({
        channel: relay.connection,
        autoCopy: false,
      });
      keyboard.attach();
      mouse.attach();

      const errors: RustDeskError[] = [];
      const permissions = new SessionPermissions({
        onError: (error) => errors.push(error),
      });
      permissions.bind({ keyboard, mouse, clipboard });

      const keyEvents = () =>
        mock.inputs.flatMap((message) =>
          message.key_event ? [message.key_event] : [],
        );
      const mouseEvents = () =>
        mock.inputs.flatMap((message) =>
          message.mouse_event ? [message.mouse_event] : [],
        );
      const clipboardEvents = () =>
        mock.inputs.flatMap((message) =>
          message.clipboard ? [message.clipboard] : [],
        );
      const mouseDown = () =>
        dispatchDom(canvas, 'mousedown', {
          button: 0,
          clientX: 260,
          clientY: 140,
        });

      void (async () => {
        for (;;) {
          const message = await relay!.connection.nextMessage(5000);
          permissions.handleMessage(message);
        }
      })().catch(() => undefined);

      sendKey('keydown', 'KeyA');
      await waitFor(() => keyEvents().length === 1, 2000);
      mouseDown();
      await waitFor(() => mouseEvents().length === 2, 2000);

      mock.sendPermissionInfo(PermissionInfo_Permission.Keyboard, false);
      await waitFor(() => !permissions.permissions.keyboard, 2000);
      expect(keyboard.enabled).toBe(false);
      expect(mouse.enabled).toBe(false);
      expect(keyEvents()).toHaveLength(2);
      expect(keyEvents().at(-1)?.down).toBe(false);
      expect(mouseEvents()).toHaveLength(3);
      expect(mouseEvents().at(-1)?.mask).toBe(10);
      expect(clipboard.sendText('blocked')).toBe(false);
      expect(clipboardEvents()).toEqual([]);
      expect(errors.map((error) => error.code)).toEqual(['no-permission']);

      sendKey('keydown', 'KeyB');
      mouseDown();
      await settle();
      expect(keyEvents()).toHaveLength(2);
      expect(mouseEvents()).toHaveLength(3);

      mock.sendPermissionInfo(PermissionInfo_Permission.Keyboard, true);
      await waitFor(() => permissions.permissions.keyboard, 2000);
      sendKey('keydown', 'KeyC');
      await waitFor(() => keyEvents().length === 3, 2000);
      mouseDown();
      await waitFor(() => mouseEvents().length === 5, 2000);
      expect(clipboard.sendText('恢复')).toBe(true);
      await waitFor(() => clipboardEvents().length === 1, 2000);

      permissions.setReadOnly(true);
      expect(keyboard.enabled).toBe(false);
      expect(mouse.enabled).toBe(false);
      expect(clipboard.enabled).toBe(false);
      expect(clipboard.receiveEnabled).toBe(false);
      await waitFor(() => keyEvents().length === 4, 2000);
      await waitFor(() => mouseEvents().length === 6, 2000);

      const keyCount = keyEvents().length;
      const mouseCount = mouseEvents().length;
      sendKey('keydown', 'KeyD');
      mouseDown();
      await settle();
      expect(keyEvents()).toHaveLength(keyCount);
      expect(mouseEvents()).toHaveLength(mouseCount);
      expect(clipboard.sendText('read-only')).toBe(false);

      permissions.setReadOnly(false);
      expect(keyboard.enabled).toBe(true);
      sendKey('keydown', 'KeyE');
      await waitFor(() => keyEvents().length === keyCount + 1, 2000);
      expect(clipboard.sendText('end')).toBe(true);
      await waitFor(() => clipboardEvents().length === 2, 2000);
      expect(errors).toHaveLength(1);
    } finally {
      clipboard?.dispose();
      mouse?.dispose();
      keyboard?.dispose();
      relay?.close();
      await mock.close();
    }
  });
});
