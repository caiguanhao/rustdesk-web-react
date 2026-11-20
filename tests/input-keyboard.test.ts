// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KeyboardInput,
  type KeyboardChannel,
  type KeyboardInputOptions,
} from '../src/input/keyboard';
import {
  ControlKey,
  KeyboardMode,
  type DeepPartial,
  type KeyEvent,
  type Message,
} from '../src/protocol/message';
import { RustDeskError } from '../src/session/errors';

// P3-2 unit coverage: Map-mode encoding, physical modifiers, lock hints,
// repeat/keyup semantics, composition guards, release-all/disable/detach,
// platform switching, special actions and send errors. The real relay and
// browser paths are covered by the Node integration and Playwright tests.

type SentKey = KeyEvent;

function fakeChannel(
  forward?: KeyboardChannel,
): KeyboardChannel & { sent: SentKey[] } {
  const sent: SentKey[] = [];
  return {
    sent,
    sendMessage(payload: DeepPartial<Message>) {
      if (payload.key_event) sent.push(payload.key_event as KeyEvent);
      forward?.sendMessage(payload);
    },
  };
}

const inputs: KeyboardInput[] = [];

function makeInput(
  options: Partial<Omit<KeyboardInputOptions, 'channel'>> = {},
  forward?: KeyboardChannel,
): { input: KeyboardInput; channel: ReturnType<typeof fakeChannel> } {
  const channel = fakeChannel(forward);
  const input = new KeyboardInput({ channel, platform: 'Windows', ...options });
  inputs.push(input);
  return { input, channel };
}

function dispatchKey(
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit = {},
  modifierState: Record<string, boolean> = {},
  target: EventTarget = document,
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    code: 'KeyA',
    key: 'a',
    ...init,
  });
  Object.defineProperty(event, 'getModifierState', {
    configurable: true,
    value: (key: string) => modifierState[key] ?? false,
  });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const input of inputs.splice(0)) input.detach();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('KeyboardInput', () => {
  it('sends Map keydown and keyup for a physical key', () => {
    const { input, channel } = makeInput();
    input.attach();
    const down = dispatchKey('keydown', { code: 'KeyA' });
    const up = dispatchKey('keyup', { code: 'KeyA' });

    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(false);
    expect(channel.sent).toEqual([
      {
        down: true,
        press: false,
        chr: 30,
        modifiers: [],
        mode: KeyboardMode.Map,
      },
      {
        down: false,
        press: false,
        chr: 30,
        modifiers: [],
        mode: KeyboardMode.Map,
      },
    ]);
  });

  it('sends repeat keydowns as another down event (never press)', () => {
    const { input, channel } = makeInput();
    input.attach();
    dispatchKey('keydown', { code: 'KeyA' });
    dispatchKey('keydown', { code: 'KeyA', repeat: true });
    dispatchKey('keyup', { code: 'KeyA' });
    expect(channel.sent.map((event) => event.down)).toEqual([true, true, false]);
    expect(channel.sent.every((event) => event.press === false)).toBe(true);
  });

  it('forwards modifiers as ordinary physical keys, not modifier flags', () => {
    const { input, channel } = makeInput();
    input.attach();
    dispatchKey('keydown', { code: 'ShiftLeft', key: 'Shift' });
    dispatchKey('keydown', { code: 'KeyA', altKey: true, ctrlKey: true });
    dispatchKey('keyup', { code: 'KeyA' });
    dispatchKey('keyup', { code: 'ShiftLeft', key: 'Shift' });
    expect(channel.sent.map((event) => event.chr)).toEqual([42, 30, 30, 42]);
    expect(channel.sent.every((event) => event.modifiers.length === 0)).toBe(
      true,
    );
  });

  it('attaches CapsLock/NumLock snapshots to printable/numpad keys', () => {
    const { input, channel } = makeInput();
    input.attach();
    dispatchKey('keydown', { code: 'KeyA' }, { CapsLock: true });
    dispatchKey('keyup', { code: 'KeyA' }, { CapsLock: false });
    dispatchKey('keydown', { code: 'Numpad5' }, { NumLock: true });
    dispatchKey('keyup', { code: 'Numpad5' }, { NumLock: true });
    dispatchKey('keydown', { code: 'CapsLock', key: 'CapsLock' }, { CapsLock: true });

    expect(channel.sent[0]?.modifiers).toEqual([ControlKey.CapsLock]);
    // Key-up refreshes the browser's lock state.
    expect(channel.sent[1]?.modifiers).toEqual([]);
    expect(channel.sent[2]?.modifiers).toEqual([ControlKey.NumLock]);
    expect(channel.sent[3]?.modifiers).toEqual([ControlKey.NumLock]);
    expect(channel.sent[4]?.modifiers).toEqual([]);
  });

  it('does not intercept composition/soft-keyboard events', () => {
    const { input, channel } = makeInput();
    input.attach();
    const composing = dispatchKey('keydown', {
      code: 'KeyA',
      isComposing: true,
    });
    const key229 = dispatchKey('keydown', { code: 'KeyA', keyCode: 229 });
    const process = dispatchKey('keydown', { code: 'KeyA', key: 'Process' });
    const unidentified = dispatchKey('keydown', {
      code: 'Unidentified',
      key: 'Unidentified',
    });
    expect([composing, key229, process, unidentified].map((event) => event.defaultPrevented)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(channel.sent).toEqual([]);
  });

  it('delivers soft-keyboard control keys that have no DOM code', () => {
    const { input, channel } = makeInput();
    input.attach();
    const down = dispatchKey('keydown', {
      code: '',
      key: 'Backspace',
      keyCode: 8,
    });
    const up = dispatchKey('keyup', {
      code: '',
      key: 'Backspace',
      keyCode: 8,
    });
    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(false);
    expect(channel.sent).toEqual([
      {
        down: true,
        press: false,
        chr: 14,
        modifiers: [],
        mode: KeyboardMode.Map,
      },
      {
        down: false,
        press: false,
        chr: 14,
        modifiers: [],
        mode: KeyboardMode.Map,
      },
    ]);

    // 229 without a known control-key name remains IME input, not a key.
    const unknown = dispatchKey('keydown', {
      code: '',
      key: 'Unidentified',
      keyCode: 229,
    });
    expect(unknown.defaultPrevented).toBe(false);
    expect(channel.sent).toHaveLength(2);
  });

  it('respects the preventDefault policy', () => {
    const { input } = makeInput({ preventDefault: false });
    input.attach();
    expect(dispatchKey('keydown', { code: 'Tab', key: 'Tab' }).defaultPrevented).toBe(
      false,
    );
  });

  it('drops unknown platforms unprevented and unknown codes after preventing', () => {
    const { input, channel } = makeInput({ platform: 'iOS' });
    input.attach();
    expect(
      dispatchKey('keydown', { code: 'KeyA' }).defaultPrevented,
    ).toBe(false);
    expect(channel.sent).toEqual([]);

    input.setPlatform('Windows');
    const unknown = dispatchKey('keydown', { code: 'Pause', key: 'Pause' });
    expect(unknown.defaultPrevented).toBe(true);
    expect(channel.sent).toEqual([]);
  });

  it('sends the macOS KeyA code 0 instead of treating it as unset', () => {
    const { input, channel } = makeInput({ platform: 'Mac OS' });
    input.attach();
    dispatchKey('keydown', { code: 'KeyA' });
    dispatchKey('keyup', { code: 'KeyA' });
    expect(channel.sent.map((event) => event.chr)).toEqual([0, 0]);
  });

  it('releases held keys in reverse order on focus/blur/pagehide/visibility', () => {
    const { input, channel } = makeInput();
    input.attach();
    dispatchKey('keydown', { code: 'ShiftLeft', key: 'Shift' });
    dispatchKey('keydown', { code: 'KeyA' }, { CapsLock: true });
    window.dispatchEvent(new Event('blur'));
    expect(channel.sent.slice(-2).map((event) => event.chr)).toEqual([30, 42]);
    // Synthetic release reuses the key-down lock snapshot.
    expect(channel.sent.at(-2)?.modifiers).toEqual([ControlKey.CapsLock]);

    dispatchKey('keydown', { code: 'KeyA' });
    document.dispatchEvent(new Event('focusout'));
    expect(channel.sent.at(-1)).toMatchObject({ down: false, chr: 30 });

    dispatchKey('keydown', { code: 'KeyA' });
    window.dispatchEvent(new Event('pagehide'));
    expect(channel.sent.at(-1)).toMatchObject({ down: false, chr: 30 });

    dispatchKey('keydown', { code: 'KeyA' });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(channel.sent.at(-1)).toMatchObject({ down: false, chr: 30 });
  });

  it('releases held keys when disabled and ignores input until re-enabled', () => {
    const { input, channel } = makeInput();
    input.attach();
    dispatchKey('keydown', { code: 'KeyA' });

    input.setEnabled(false);
    expect(channel.sent.at(-1)).toMatchObject({ down: false, chr: 30 });
    const count = channel.sent.length;
    dispatchKey('keydown', { code: 'KeyB' });
    expect(channel.sent).toHaveLength(count);

    input.setEnabled(true);
    dispatchKey('keydown', { code: 'KeyB' });
    expect(channel.sent.at(-1)).toMatchObject({ chr: 48, down: true });
  });

  it('releases held keys with the old platform and remaps new keys', () => {
    const { input, channel } = makeInput();
    input.attach();
    dispatchKey('keydown', { code: 'KeyA' });
    input.setPlatform('Mac OS');
    expect(channel.sent.at(-1)).toMatchObject({ down: false, chr: 30 });

    dispatchKey('keydown', { code: 'KeyA' });
    expect(channel.sent.at(-1)).toMatchObject({ down: true, chr: 0 });
  });

  it('attaches idempotently, detaches cleanly and releases held keys', () => {
    const { input, channel } = makeInput();
    input.attach();
    input.attach();
    dispatchKey('keydown', { code: 'KeyA' });
    expect(channel.sent).toHaveLength(1);

    input.detach();
    expect(channel.sent.at(-1)).toMatchObject({ down: false, chr: 30 });
    const count = channel.sent.length;
    dispatchKey('keydown', { code: 'KeyB' });
    expect(channel.sent).toHaveLength(count);
  });

  it('sends Ctrl+Alt+Del and LockScreen with Legacy control keys', () => {
    const windows = makeInput({ platform: 'Windows' });
    windows.input.attach();
    windows.input.sendCtrlAltDel();
    expect(windows.channel.sent.at(-1)).toEqual({
      down: true,
      press: false,
      control_key: ControlKey.CtrlAltDel,
      modifiers: [],
      mode: KeyboardMode.Legacy,
    });

    const linux = makeInput({ platform: 'Linux' });
    linux.input.attach();
    linux.input.sendCtrlAltDel();
    expect(linux.channel.sent.at(-1)).toEqual({
      down: true,
      press: true,
      control_key: ControlKey.Delete,
      modifiers: [ControlKey.Alt, ControlKey.Control],
      mode: KeyboardMode.Legacy,
    });

    linux.input.sendLockScreen();
    expect(linux.channel.sent.at(-1)).toEqual({
      down: true,
      press: false,
      control_key: ControlKey.LockScreen,
      modifiers: [],
      mode: KeyboardMode.Legacy,
    });

    linux.input.setEnabled(false);
    const count = linux.channel.sent.length;
    linux.input.sendCtrlAltDel();
    linux.input.sendLockScreen();
    expect(linux.channel.sent).toHaveLength(count);

    const unknown = makeInput({ platform: 'iOS' });
    unknown.input.attach();
    unknown.input.sendCtrlAltDel();
    expect(unknown.channel.sent).toEqual([]);
  });

  it('supports ISO Macs and the Ctrl/Meta swap option', () => {
    const mac = makeInput({ platform: 'Mac OS', macIsoLayout: true });
    mac.input.attach();
    dispatchKey('keydown', { code: 'Backquote', key: '`' });
    dispatchKey('keyup', { code: 'Backquote', key: '`' });
    expect(mac.channel.sent.map((event) => event.chr)).toEqual([10, 10]);

    const swapped = makeInput({
      platform: 'Mac OS',
      swapControlCommand: true,
    });
    swapped.input.attach();
    dispatchKey('keydown', { code: 'ControlLeft', key: 'Control' });
    expect(swapped.channel.sent.at(-1)?.chr).toBe(55);
  });

  it('reports send failures without throwing from DOM handlers', () => {
    const errors: RustDeskError[] = [];
    const throwing: KeyboardChannel = {
      sendMessage() {
        throw new Error('relay closed');
      },
    };
    const { input } = makeInput({ onError: (error) => errors.push(error) }, throwing);
    input.attach();
    expect(() => dispatchKey('keydown', { code: 'KeyA' })).not.toThrow();
    expect(errors.map((error) => error.code)).toEqual(['connection-lost']);
  });
});
