/**
 * DOM keyboard → RustDesk `KeyEvent` encoder in Map mode (P3-2).
 *
 * Physical keys are sent as `{chr, mode: Map, down, press: false}` where `chr`
 * is the peer platform's position keycode (Windows scancode, Linux X11 code,
 * Android keycode, macOS virtual keycode). Ctrl/Alt/Shift/Meta are ordinary
 * physical key events, not `modifiers`; only CapsLock/NumLock state is added
 * as LED-sync modifiers on printable/numpad keys.
 *
 * Auto-repeat is another `down:true` Map event. `press:true` is a Legacy-mode
 * click and is not used here; the old plan note that repeats use `press:true`
 * applies to the Flutter Legacy path, not Map mode. Key-up is `down:false`;
 * held keys are released on blur, page hide, visibility hide, disable and
 * detach so the peer cannot keep a key stuck.
 *
 * IME/soft-keyboard text (`seq`/Translate) is P3-3. Events during composition
 * (`isComposing`, keyCode 229, key "Process") are ignored here so P3-3 can own
 * them.
 */
import type { RelayConnection } from '../protocol/connection.js';
import {
  ControlKey,
  KeyboardMode,
  type KeyEvent,
} from '../protocol/message.js';
import { RustDeskError } from '../session/errors.js';
import {
  lockModifiersFor,
  mapDomKey,
  normalizePlatform,
  type KeyCodeOptions,
  type PeerPlatform,
} from './keymaps.js';

export type KeyboardChannel = Pick<RelayConnection, 'sendMessage'>;

export interface KeyboardInputOptions extends KeyCodeOptions {
  channel: KeyboardChannel;
  /** PeerInfo.platform: "Windows" | "Linux" | "Mac OS" | "Android" | ... */
  platform?: string;
  /** Key listener target; defaults to `document`. */
  target?: EventTarget;
  /** Policy gate for read-only/permissions/focus; default true. */
  enabled?: boolean;
  /** Intercept browser shortcuts while enabled; default true. */
  preventDefault?: boolean;
  onError?: (error: RustDeskError) => void;
}

function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229 || event.key === 'Process';
}

/**
 * Control keys that Android soft keyboards (SwiftKey et al.) send with an
 * empty `code` and only a legacy `key` name. Printable keys are deliberately
 * absent: composition text is owned by P3-3 (`seq`), and mapping letters here
 * would duplicate it as physical keycodes.
 */
const KEY_CODE_FALLBACK: Readonly<Record<string, string>> = {
  Backspace: 'Backspace',
  Delete: 'Delete',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
};

interface ResolvedKey {
  code: string;
  /** True when `code` came from event.key rather than event.code. */
  fallback: boolean;
}

function resolveKey(event: KeyboardEvent): ResolvedKey | null {
  if (event.code && event.code !== 'Unidentified') {
    return { code: event.code, fallback: false };
  }
  const code = KEY_CODE_FALLBACK[event.key];
  return code ? { code, fallback: true } : null;
}

export class KeyboardInput {
  private readonly channel: KeyboardChannel;
  private readonly targetOption?: EventTarget;
  private readonly preventDefaultValue: boolean;
  private readonly swapControlCommand: boolean;
  private readonly macIsoLayout: boolean;
  private readonly onError?: (error: RustDeskError) => void;
  /** Held key-down events; releasing reuses their chr and lock snapshot. */
  private readonly held = new Map<string, KeyEvent>();
  private platform: PeerPlatform | null;
  private enabledValue: boolean;
  private target?: EventTarget;

  constructor(options: KeyboardInputOptions) {
    this.channel = options.channel;
    this.targetOption = options.target;
    this.platform = normalizePlatform(options.platform ?? '');
    this.enabledValue = options.enabled ?? true;
    this.preventDefaultValue = options.preventDefault ?? true;
    this.swapControlCommand = options.swapControlCommand ?? false;
    this.macIsoLayout = options.macIsoLayout ?? false;
    this.onError = options.onError;
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabledValue) return;
    if (!enabled) this.releaseAll();
    this.enabledValue = enabled;
  }

  /** Update after login/peer_info or a reconnect; releases held keys first. */
  setPlatform(platform: string): void {
    const next = normalizePlatform(platform);
    if (next === this.platform) return;
    this.releaseAll();
    this.platform = next;
  }

  attach(): void {
    if (this.target || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    const target = this.targetOption ?? document;
    target.addEventListener('keydown', this.onKeyDown as EventListener);
    target.addEventListener('keyup', this.onKeyUp as EventListener);
    target.addEventListener('focusout', this.onFocusOut);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.target = target;
  }

  detach(): void {
    const target = this.target;
    if (!target) return;
    this.releaseAll();
    target.removeEventListener('keydown', this.onKeyDown as EventListener);
    target.removeEventListener('keyup', this.onKeyUp as EventListener);
    target.removeEventListener('focusout', this.onFocusOut);
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', this.onBlur);
      window.removeEventListener('pagehide', this.onPageHide);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.target = undefined;
  }

  dispose(): void {
    this.detach();
    this.enabledValue = false;
  }

  /** Send key-ups for every held key (focus loss, view-only, teardown). */
  private releaseAll(): void {
    const entries = [...this.held.values()].reverse();
    this.held.clear();
    for (const held of entries) this.send({ ...held, down: false });
  }

  sendCtrlAltDel(): void {
    if (!this.enabledValue || !this.platform) return;
    if (this.platform === 'windows') {
      this.send({
        down: true,
        press: false,
        control_key: ControlKey.CtrlAltDel,
        modifiers: [],
        mode: KeyboardMode.Legacy,
      });
    } else {
      // Match Rust desktop: Delete press with Ctrl+Alt. A single down would
      // leave Delete held on macOS because the server ignores up for it.
      this.send({
        down: true,
        press: true,
        control_key: ControlKey.Delete,
        modifiers: [ControlKey.Alt, ControlKey.Control],
        mode: KeyboardMode.Legacy,
      });
    }
  }

  sendLockScreen(): void {
    if (!this.enabledValue) return;
    this.send({
      down: true,
      press: false,
      control_key: ControlKey.LockScreen,
      modifiers: [],
      mode: KeyboardMode.Legacy,
    });
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabledValue || !this.platform) return;
    const resolved = resolveKey(event);
    if (!resolved) return;
    // keyCode 229 marks IME processing. The key-derived control keys are the
    // exception: Android IMEs report 229 for Backspace even when no
    // composition is active, and there is no other way to receive it.
    if (isComposing(event) && !resolved.fallback) return;
    if (this.preventDefaultValue) event.preventDefault();

    const encoded = mapDomKey(
      event,
      {
        platform: this.platform,
        down: true,
        swapControlCommand: this.swapControlCommand,
        macIsoLayout: this.macIsoLayout,
      },
      resolved.code,
    );
    if (!encoded) return;
    this.held.set(resolved.code, encoded);
    this.send(encoded);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (!this.enabledValue) return;
    const resolved = resolveKey(event);
    if (!resolved) return;
    const held = this.held.get(resolved.code);
    // A key we actually pressed must always be released, even if the IME
    // marks its keyup as composing.
    if (!held && isComposing(event) && !resolved.fallback) return;
    this.held.delete(resolved.code);
    if (held) {
      // Reuse the key-down chr so a platform change cannot release a
      // different key; refresh lock hints from the current browser state.
      this.send({
        ...held,
        down: false,
        modifiers: lockModifiersFor(resolved.code, event),
      });
      return;
    }
    if (!this.platform) return;
    const encoded = mapDomKey(
      event,
      {
        platform: this.platform,
        down: false,
        swapControlCommand: this.swapControlCommand,
        macIsoLayout: this.macIsoLayout,
      },
      resolved.code,
    );
    if (encoded) this.send(encoded);
  };

  private readonly onFocusOut = (): void => {
    this.releaseAll();
  };

  private readonly onBlur = (): void => {
    this.releaseAll();
  };

  private readonly onPageHide = (): void => {
    this.releaseAll();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.releaseAll();
  };

  private send(keyEvent: KeyEvent): void {
    try {
      this.channel.sendMessage({ key_event: keyEvent });
    } catch (cause) {
      this.report(
        new RustDeskError('connection-lost', 'Failed to send key input', {
          cause,
        }),
      );
    }
  }

  private report(error: RustDeskError): void {
    try {
      this.onError?.(error);
    } catch {
      // Host callbacks must not break input handling.
    }
  }
}
