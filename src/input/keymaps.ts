/**
 * DOM KeyboardEvent.code -> RustDesk position keycodes (P3-2).
 *
 * Map mode sends KeyEvent{chr, mode: Map, down, press: false}; the peer
 * interprets chr as a Windows scancode, a Linux X11 keycode (evdev + 8), an
 * Android keycode, or a macOS virtual keycode. Values are transcribed from the
 * rustdesk-web v2 bundle (js/dist/index.js, commit
 * 10a477b67f7411da21fe88f4809eab7cb81e6102, AGPL-3.0): table Lo
 * (DOM code -> name) fed into _e/No/Oo/Uo (per-platform codes). See NOTICE /
 * src/input/NOTICE.md.
 *
 * Windows extended scancodes are encoded as 0xE0xx (e.g. ArrowUp = 57416).
 * Values of 0 are valid (KeyA on macOS); always check for undefined.
 */
import { ControlKey, KeyboardMode, type KeyEvent } from '../protocol/message.js';

export type PeerPlatform = 'windows' | 'linux' | 'android' | 'macos';

export interface KeyCodeOptions {
  /** Client option allow_swap_key: send Ctrl as Meta and Meta as Ctrl. */
  swapControlCommand?: boolean;
  /** macOS ISO keyboard: IntlBackslash and Backquote swap. */
  macIsoLayout?: boolean;
}

// Android Backquote is 75 in the v2 bundle (same as Quote); Android's
// KEYCODE_GRAVE is 68, so this may be an upstream bug. Kept as published
// until a real Android peer verifies Map mode (P5-2).
const KEY_TABLE: Record<string, Partial<Record<PeerPlatform, number>>> = {
  AltLeft: { windows: 56, linux: 64, android: 57, macos: 58 },
  AltRight: { windows: 57400, linux: 108, android: 58, macos: 61 },
  Backspace: { windows: 14, linux: 22, android: 67, macos: 51 },
  CapsLock: { windows: 58, linux: 66, android: 115, macos: 57 },
  ControlLeft: { windows: 29, linux: 37, android: 113, macos: 59 },
  ControlRight: { windows: 57373, linux: 105, android: 114, macos: 62 },
  Delete: { windows: 57427, linux: 119, android: 112, macos: 117 },
  ArrowUp: { windows: 57416, linux: 111, android: 19, macos: 126 },
  ArrowDown: { windows: 57424, linux: 116, android: 20, macos: 125 },
  ArrowLeft: { windows: 57419, linux: 113, android: 21, macos: 123 },
  ArrowRight: { windows: 57421, linux: 114, android: 22, macos: 124 },
  End: { windows: 57423, linux: 115, android: 123, macos: 119 },
  Escape: { windows: 1, linux: 9, android: 111, macos: 53 },
  F1: { windows: 59, linux: 67, android: 131, macos: 122 },
  F2: { windows: 60, linux: 68, android: 132, macos: 120 },
  F3: { windows: 61, linux: 69, android: 133, macos: 99 },
  F4: { windows: 62, linux: 70, android: 134, macos: 118 },
  F5: { windows: 63, linux: 71, android: 135, macos: 96 },
  F6: { windows: 64, linux: 72, android: 136, macos: 97 },
  F7: { windows: 65, linux: 73, android: 137, macos: 98 },
  F8: { windows: 66, linux: 74, android: 138, macos: 100 },
  F9: { windows: 67, linux: 75, android: 139, macos: 101 },
  F10: { windows: 68, linux: 76, android: 140, macos: 109 },
  F11: { windows: 87, linux: 95, android: 141, macos: 103 },
  F12: { windows: 88, linux: 96, android: 142, macos: 111 },
  F13: { windows: 100, linux: 191, macos: 105 },
  F14: { windows: 101, linux: 192, macos: 107 },
  F15: { windows: 102, linux: 193, macos: 113 },
  F16: { windows: 103, linux: 194, macos: 106 },
  F17: { windows: 104, linux: 195, macos: 64 },
  F18: { windows: 105, linux: 196, macos: 79 },
  F19: { windows: 106, linux: 197, macos: 80 },
  F20: { windows: 107, linux: 198, macos: 90 },
  F21: { windows: 108, linux: 199 },
  F22: { windows: 109, linux: 200 },
  F23: { windows: 110, linux: 201 },
  F24: { windows: 118, linux: 202 },
  Home: { windows: 57415, linux: 110, android: 3, macos: 115 },
  MetaLeft: { windows: 57435, linux: 133, android: 117, macos: 55 },
  PageDown: { windows: 57425, linux: 117, android: 93, macos: 121 },
  PageUp: { windows: 57417, linux: 112, android: 92, macos: 116 },
  Enter: { windows: 28, linux: 36, android: 66, macos: 36 },
  ShiftLeft: { windows: 42, linux: 50, android: 59, macos: 56 },
  ShiftRight: { windows: 54, linux: 62, android: 60, macos: 60 },
  Space: { windows: 57, linux: 65, android: 62, macos: 49 },
  Tab: { windows: 15, linux: 23, android: 61, macos: 48 },
  PrintScreen: { windows: 57399, linux: 107, android: 120 },
  ScrollLock: { windows: 70, linux: 78, android: 116 },
  NumLock: { windows: 69, linux: 77, android: 143, macos: 71 },
  Backquote: { windows: 41, linux: 49, android: 75, macos: 50 },
  Digit1: { windows: 2, linux: 10, android: 8, macos: 18 },
  Digit2: { windows: 3, linux: 11, android: 9, macos: 19 },
  Digit3: { windows: 4, linux: 12, android: 10, macos: 20 },
  Digit4: { windows: 5, linux: 13, android: 11, macos: 21 },
  Digit5: { windows: 6, linux: 14, android: 12, macos: 23 },
  Digit6: { windows: 7, linux: 15, android: 13, macos: 22 },
  Digit7: { windows: 8, linux: 16, android: 14, macos: 26 },
  Digit8: { windows: 9, linux: 17, android: 15, macos: 28 },
  Digit9: { windows: 10, linux: 18, android: 16, macos: 25 },
  Digit0: { windows: 11, linux: 19, android: 7, macos: 29 },
  Minus: { windows: 12, linux: 20, android: 69, macos: 27 },
  Equal: { windows: 13, linux: 21, android: 70, macos: 24 },
  KeyQ: { windows: 16, linux: 24, android: 45, macos: 12 },
  KeyW: { windows: 17, linux: 25, android: 51, macos: 13 },
  KeyE: { windows: 18, linux: 26, android: 33, macos: 14 },
  KeyR: { windows: 19, linux: 27, android: 46, macos: 15 },
  KeyT: { windows: 20, linux: 28, android: 48, macos: 17 },
  KeyY: { windows: 21, linux: 29, android: 53, macos: 16 },
  KeyU: { windows: 22, linux: 30, android: 49, macos: 32 },
  KeyI: { windows: 23, linux: 31, android: 37, macos: 34 },
  KeyO: { windows: 24, linux: 32, android: 43, macos: 31 },
  KeyP: { windows: 25, linux: 33, android: 44, macos: 35 },
  BracketLeft: { windows: 26, linux: 34, android: 71, macos: 33 },
  BracketRight: { windows: 27, linux: 35, android: 72, macos: 30 },
  Backslash: { windows: 43, linux: 51, android: 73, macos: 42 },
  KeyA: { windows: 30, linux: 38, android: 29, macos: 0 },
  KeyS: { windows: 31, linux: 39, android: 47, macos: 1 },
  KeyD: { windows: 32, linux: 40, android: 32, macos: 2 },
  KeyF: { windows: 33, linux: 41, android: 34, macos: 3 },
  KeyG: { windows: 34, linux: 42, android: 35, macos: 5 },
  KeyH: { windows: 35, linux: 43, android: 36, macos: 4 },
  KeyJ: { windows: 36, linux: 44, android: 38, macos: 38 },
  KeyK: { windows: 37, linux: 45, android: 39, macos: 40 },
  KeyL: { windows: 38, linux: 46, android: 40, macos: 37 },
  Semicolon: { windows: 39, linux: 47, android: 74, macos: 41 },
  Quote: { windows: 40, linux: 48, android: 75, macos: 39 },
  IntlBackslash: { windows: 86, linux: 94, macos: 10 },
  IntlRo: { windows: 115, linux: 97, macos: 94 },
  IntlYen: { windows: 125, linux: 132, macos: 93 },
  KanaMode: { windows: 112, linux: 101, android: 218 },
  KeyZ: { windows: 44, linux: 52, android: 54, macos: 6 },
  KeyX: { windows: 45, linux: 53, android: 52, macos: 7 },
  KeyC: { windows: 46, linux: 54, android: 31, macos: 8 },
  KeyV: { windows: 47, linux: 55, android: 50, macos: 9 },
  KeyB: { windows: 48, linux: 56, android: 30, macos: 11 },
  KeyN: { windows: 49, linux: 57, android: 42, macos: 45 },
  KeyM: { windows: 50, linux: 58, android: 41, macos: 46 },
  Comma: { windows: 51, linux: 59, android: 55, macos: 43 },
  Period: { windows: 52, linux: 60, android: 56, macos: 47 },
  Slash: { windows: 53, linux: 61, android: 76, macos: 44 },
  Insert: { windows: 57426, linux: 118, android: 124, macos: 114 },
  NumpadSubtract: { windows: 74, linux: 82, macos: 78 },
  NumpadAdd: { windows: 78, linux: 86, macos: 69 },
  NumpadMultiply: { windows: 55, linux: 63, macos: 67 },
  NumpadDivide: { windows: 57397, linux: 106, macos: 75 },
  NumpadDecimal: { windows: 83, linux: 91, macos: 65 },
  NumpadEnter: { windows: 57372, linux: 104, macos: 76 },
  NumpadEqual: { windows: 89, linux: 125, macos: 81 },
  NumpadComma: { windows: 126, linux: 129, macos: 95 },
  Numpad0: { windows: 82, linux: 90, macos: 82 },
  Numpad1: { windows: 79, linux: 87, macos: 83 },
  Numpad2: { windows: 80, linux: 88, macos: 84 },
  Numpad3: { windows: 81, linux: 89, macos: 85 },
  Numpad4: { windows: 75, linux: 83, macos: 86 },
  Numpad5: { windows: 76, linux: 84, macos: 87 },
  Numpad6: { windows: 77, linux: 85, macos: 88 },
  Numpad7: { windows: 71, linux: 79, macos: 89 },
  Numpad8: { windows: 72, linux: 80, macos: 91 },
  Numpad9: { windows: 73, linux: 81, macos: 92 },
  MetaRight: { windows: 57436, linux: 134, macos: 54 },
  ContextMenu: { windows: 57437, linux: 135, macos: 110 },
  AudioVolumeUp: { windows: 57392, linux: 123, macos: 72 },
  AudioVolumeDown: { windows: 57390, linux: 122, macos: 73 },
  AudioVolumeMute: { windows: 57376, linux: 121, macos: 74 },
  NonConvert: { windows: 123, linux: 102, macos: 104 },
  Convert: { windows: 121, linux: 100, macos: 102 },
  Lang3: { windows: 120, linux: 98 },
  Lang4: { windows: 119, linux: 99 },
  Lang5: { windows: 118, linux: 93 },
};

export function normalizePlatform(platform: string): PeerPlatform | null {
  switch (platform.trim().toLowerCase()) {
    case 'windows':
      return 'windows';
    case 'linux':
      return 'linux';
    case 'android':
      return 'android';
    case 'mac os':
    case 'macos':
    case 'darwin':
      return 'macos';
    default:
      return null;
  }
}

export function keycodeFor(
  platform: PeerPlatform,
  code: string,
  options: KeyCodeOptions = {},
): number | undefined {
  let key = code;
  if (options.swapControlCommand) {
    if (key === 'ControlLeft' || key === 'ControlRight') key = 'MetaLeft';
    else if (key === 'MetaLeft' || key === 'MetaRight') key = 'ControlLeft';
  }
  if (platform === 'macos' && options.macIsoLayout) {
    if (key === 'IntlBackslash') key = 'Backquote';
    else if (key === 'Backquote') key = 'IntlBackslash';
  }
  return KEY_TABLE[key]?.[platform];
}

// The official web client adds CapsLock only for printable keys and NumLock
// only for numpad keys, using the browser's current lock state. These are LED
// synchronization hints, not held modifiers.
const PRINTABLE_CODES = new Set([
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'IntlBackslash',
  'Space',
  ...Array.from({ length: 10 }, (_, index) => 'Digit' + index),
  ...Array.from({ length: 26 }, (_, index) =>
    'Key' + String.fromCharCode(65 + index),
  ),
]);

const NUMPAD_CODES = new Set([
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadAdd',
  'NumpadDecimal',
  ...Array.from({ length: 10 }, (_, index) => 'Numpad' + index),
]);

export interface ModifierStateSource {
  getModifierState?(key: string): boolean;
}

function modifierState(event: ModifierStateSource, key: string): boolean {
  try {
    return event.getModifierState?.(key) === true;
  } catch {
    return false;
  }
}

export function lockModifiersFor(
  code: string,
  event: ModifierStateSource,
): ControlKey[] {
  const modifiers: ControlKey[] = [];
  if (PRINTABLE_CODES.has(code) && modifierState(event, 'CapsLock')) {
    modifiers.push(ControlKey.CapsLock);
  }
  if (NUMPAD_CODES.has(code) && modifierState(event, 'NumLock')) {
    modifiers.push(ControlKey.NumLock);
  }
  return modifiers;
}

export interface DomKeyEncodingOptions extends KeyCodeOptions {
  platform: PeerPlatform;
  down: boolean;
}

/**
 * Encode one DOM key event in Map mode; null for unknown code.
 *
 * `code` defaults to `event.code`; soft keyboards (notably Android IMEs) can
 * send a control key with an empty `code`, in which case the caller passes the
 * `event.key`-derived code instead.
 */
export function mapDomKey(
  event: Pick<KeyboardEvent, 'code'> & ModifierStateSource,
  options: DomKeyEncodingOptions,
  code: string = event.code,
): KeyEvent | null {
  const chr = keycodeFor(options.platform, code, options);
  if (chr === undefined) return null;
  return {
    down: options.down,
    press: false,
    chr,
    modifiers: lockModifiersFor(code, event),
    mode: KeyboardMode.Map,
  };
}
