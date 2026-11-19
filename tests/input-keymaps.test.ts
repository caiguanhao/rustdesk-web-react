import { describe, expect, it } from 'vitest';
import {
  keycodeFor,
  lockModifiersFor,
  mapDomKey,
  normalizePlatform,
  type ModifierStateSource,
} from '../src/input/keymaps';
import { ControlKey, KeyboardMode } from '../src/protocol/message';

// P3-2 table coverage: values are from the rustdesk-web v2 bundle
// (js/dist/index.js _e/No/Oo/Uo), consumed by RustDesk's Map mode.

function state(values: Record<string, boolean>): ModifierStateSource {
  return { getModifierState: (key) => values[key] ?? false };
}

describe('keyboard platform maps', () => {
  it('normalizes peer platform strings', () => {
    expect(normalizePlatform('Windows')).toBe('windows');
    expect(normalizePlatform('Linux')).toBe('linux');
    expect(normalizePlatform('Android')).toBe('android');
    expect(normalizePlatform('Mac OS')).toBe('macos');
    expect(normalizePlatform('macOS')).toBe('macos');
    expect(normalizePlatform('iOS')).toBeNull();
    expect(normalizePlatform('')).toBeNull();
  });

  it.each([
    ['KeyA', 30, 38, 29, 0],
    ['Enter', 28, 36, 66, 36],
    ['ArrowUp', 57416, 111, 19, 126],
    ['Delete', 57427, 119, 112, 117],
    ['ControlRight', 57373, 105, 114, 62],
    ['AltRight', 57400, 108, 58, 61],
    ['Numpad4', 75, 83, undefined, 86],
    ['NumpadEnter', 57372, 104, undefined, 76],
    ['ContextMenu', 57437, 135, undefined, 110],
    ['F13', 100, 191, undefined, 105],
    ['IntlBackslash', 86, 94, undefined, 10],
  ])(
    'maps %s to Windows/Linux/Android/macOS codes',
    (code, windows, linux, android, macos) => {
      expect(keycodeFor('windows', code)).toBe(windows);
      expect(keycodeFor('linux', code)).toBe(linux);
      expect(keycodeFor('android', code)).toBe(android);
      expect(keycodeFor('macos', code)).toBe(macos);
    },
  );

  it('keeps macOS KeyA = 0 distinct from an unknown key', () => {
    expect(keycodeFor('macos', 'KeyA')).toBe(0);
    expect(keycodeFor('macos', 'Pause')).toBeUndefined();
    expect(keycodeFor('windows', 'Pause')).toBeUndefined();
  });

  it('swaps IntlBackslash/Backquote for ISO Macs', () => {
    expect(keycodeFor('macos', 'IntlBackslash')).toBe(10);
    expect(keycodeFor('macos', 'Backquote')).toBe(50);
    expect(keycodeFor('macos', 'IntlBackslash', { macIsoLayout: true })).toBe(50);
    expect(keycodeFor('macos', 'Backquote', { macIsoLayout: true })).toBe(10);
    expect(keycodeFor('windows', 'Backquote', { macIsoLayout: true })).toBe(41);
  });

  it('swaps Control/Meta when allow_swap_key is enabled', () => {
    expect(keycodeFor('macos', 'ControlLeft')).toBe(59);
    expect(keycodeFor('macos', 'ControlLeft', { swapControlCommand: true })).toBe(55);
    expect(keycodeFor('macos', 'ControlRight', { swapControlCommand: true })).toBe(55);
    expect(keycodeFor('macos', 'MetaLeft', { swapControlCommand: true })).toBe(59);
    expect(keycodeFor('windows', 'MetaRight', { swapControlCommand: true })).toBe(29);
    expect(keycodeFor('windows', 'ShiftLeft', { swapControlCommand: true })).toBe(42);
  });

  it('adds CapsLock/NumLock hints only to printable/numpad keys', () => {
    expect(lockModifiersFor('KeyA', state({ CapsLock: true }))).toEqual([
      ControlKey.CapsLock,
    ]);
    expect(lockModifiersFor('Space', state({ CapsLock: true }))).toEqual([
      ControlKey.CapsLock,
    ]);
    expect(lockModifiersFor('ArrowUp', state({ CapsLock: true }))).toEqual([]);
    expect(lockModifiersFor('Numpad5', state({ NumLock: true }))).toEqual([
      ControlKey.NumLock,
    ]);
    expect(lockModifiersFor('Numpad5', state({ CapsLock: true }))).toEqual([]);
    expect(lockModifiersFor('NumpadEnter', state({ NumLock: true }))).toEqual([]);
    expect(lockModifiersFor('Digit5', state({ NumLock: true }))).toEqual([]);
    expect(
      lockModifiersFor('Numpad5', state({ CapsLock: true, NumLock: true })),
    ).toEqual([ControlKey.NumLock]);
    expect(lockModifiersFor('KeyA', state({ ScrollLock: true }))).toEqual([]);
  });

  it('encodes Map-mode down/up events and ignores unknown codes', () => {
    expect(
      mapDomKey({ code: 'KeyA' }, { platform: 'windows', down: true }),
    ).toEqual({
      down: true,
      press: false,
      chr: 30,
      modifiers: [],
      mode: KeyboardMode.Map,
    });
    expect(
      mapDomKey(
        { code: 'Numpad5', getModifierState: (key) => key === 'NumLock' },
        { platform: 'linux', down: false },
      ),
    ).toEqual({
      down: false,
      press: false,
      chr: 84,
      modifiers: [ControlKey.NumLock],
      mode: KeyboardMode.Map,
    });
    expect(
      mapDomKey({ code: 'Pause' }, { platform: 'linux', down: true }),
    ).toBeNull();
    expect(
      mapDomKey({ code: 'KeyA' }, { platform: 'macos', down: true })?.chr,
    ).toBe(0);
  });
});
