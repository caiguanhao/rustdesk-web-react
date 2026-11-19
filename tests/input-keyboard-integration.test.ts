import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeyboardInput } from '../src/input/keyboard';
import { ControlKey, KeyboardMode } from '../src/protocol/message';
import {
  dispatchDom,
  installFakeDom,
  type FakeDom,
} from './mocks/fake-dom';
import {
  connectMockRelay,
  type MockRelaySession,
} from './mocks/relay-session';
import { MockRustDeskServer, waitFor } from './mocks/rustdesk-mock';

// P3-2 integration: DOM key events → KeyboardInput → encrypted relay → mock
// controlled peer (Linux platform). Real-desktop shortcuts/IME remain
// ⏳ 真机待验; IME text itself is P3-3.

let dom: FakeDom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  dom.restore();
});

function sendKey(
  type: 'keydown' | 'keyup',
  code: string,
  extra: object = {},
): void {
  dispatchDom(dom.document, type, {
    code,
    key: code,
    keyCode: 0,
    isComposing: false,
    getModifierState: () => false,
    ...extra,
  });
}

describe('keyboard input over the mock relay', () => {
  it('delivers Map-mode keys, release-all and specials to the peer', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    let relay: MockRelaySession | undefined;
    let keyboard: KeyboardInput | undefined;
    try {
      relay = await connectMockRelay(mock);
      keyboard = new KeyboardInput({
        channel: relay.connection,
        platform: relay.peerInfo.platform,
      });
      keyboard.attach();

      const keyEvents = () =>
        mock.inputs.flatMap((message) =>
          message.key_event ? [message.key_event] : [],
        );
      const waitForKeyEvents = (count: number) =>
        waitFor(() => keyEvents().length === count, 2000);

      sendKey('keydown', 'ControlLeft', { ctrlKey: true });
      sendKey('keydown', 'KeyC', { ctrlKey: true });
      sendKey('keyup', 'KeyC');
      sendKey('keyup', 'ControlLeft');

      await waitForKeyEvents(4);
      const keys = keyEvents();
      expect(keys.map((event) => event.chr)).toEqual([37, 54, 54, 37]);
      expect(keys.map((event) => event.down)).toEqual([
        true,
        true,
        false,
        false,
      ]);
      expect(
        keys.every(
          (event) =>
            event.mode === KeyboardMode.Map &&
            event.press === false &&
            event.modifiers.length === 0,
        ),
      ).toBe(true);

      sendKey('keydown', 'ShiftLeft');
      dom.window.dispatchEvent(new Event('blur'));
      await waitForKeyEvents(6);
      expect(keyEvents().at(-1)).toMatchObject({ chr: 50, down: false });

      keyboard.setEnabled(false);
      sendKey('keydown', 'KeyA');
      expect(keyEvents()).toHaveLength(6);

      keyboard.setEnabled(true);
      keyboard.sendLockScreen();
      await waitForKeyEvents(7);
      expect(keyEvents().at(-1)).toMatchObject({
        control_key: ControlKey.LockScreen,
        down: true,
        mode: KeyboardMode.Legacy,
      });

      keyboard.sendCtrlAltDel();
      await waitForKeyEvents(8);
      expect(keyEvents().at(-1)).toMatchObject({
        control_key: ControlKey.Delete,
        press: true,
        modifiers: [ControlKey.Alt, ControlKey.Control],
        mode: KeyboardMode.Legacy,
      });
    } finally {
      keyboard?.detach();
      relay?.close();
      await mock.close();
    }
  });
});
