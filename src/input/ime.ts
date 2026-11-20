/**
 * Hidden-textarea IME / soft-keyboard input (P3-3).
 *
 * Composed or inserted text is sent as a single
 * `KeyEvent{seq, mode: Translate, down:true, press:false}` rather than as
 * physical Map keycodes. The textarea is 1x1, transparent, 16px (avoids iOS
 * auto-zoom), fixed-position and focused programmatically with
 * `preventScroll` so opening the keyboard does not scroll the viewer.
 *
 * P3-2's KeyboardInput ignores `isComposing`/keyCode 229/`Process`, so
 * physical keys keep using Map mode while composition text arrives here.
 * `focus()` must be called from a user gesture (the viewer's Keyboard
 * button/tap); this module never focuses on its own.
 *
 * The task's paste requirement is handled synchronously: `clipboardData`
 * text is sent as `seq` and the default insertion is prevented. Visual
 * viewport/resize changes are surfaced through `onViewportChange` for P4-3
 * to keep the viewer aligned when the soft keyboard opens.
 */
import type { RelayConnection } from '../protocol/connection.js';
import {
  KeyboardMode,
  type KeyEvent,
} from '../protocol/message.js';
import { RustDeskError } from '../session/errors.js';

export type ImeChannel = Pick<RelayConnection, 'sendMessage'>;

export interface ViewportInfo {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  scale: number;
}

export interface ImeInputOptions {
  channel: ImeChannel;
  /** Existing textarea (P4-3); otherwise a hidden one is created. */
  element?: HTMLTextAreaElement;
  /** Where a created textarea is appended; defaults to document.body. */
  container?: HTMLElement;
  /** Policy gate for read-only/permissions; default true. */
  enabled?: boolean;
  onFocusChange?: (focused: boolean) => void;
  onViewportChange?: (viewport: ViewportInfo) => void;
  onError?: (error: RustDeskError) => void;
}

function hiddenTextarea(document: Document): HTMLTextAreaElement {
  const element = document.createElement('textarea');
  element.autocomplete = 'off';
  element.setAttribute('autocapitalize', 'off');
  element.setAttribute('autocorrect', 'off');
  element.setAttribute('spellcheck', 'false');
  element.tabIndex = -1;
  element.style.position = 'fixed';
  element.style.top = '0';
  element.style.left = '0';
  element.style.width = '1px';
  element.style.height = '1px';
  element.style.opacity = '0';
  element.style.fontSize = '16px';
  element.style.padding = '0';
  element.style.border = '0';
  element.style.margin = '0';
  element.style.overflow = 'hidden';
  return element;
}

export class ImeInput {
  private readonly channel: ImeChannel;
  private readonly providedElement?: HTMLTextAreaElement;
  private readonly container?: HTMLElement;
  private readonly onFocusChange?: (focused: boolean) => void;
  private readonly onViewportChange?: (viewport: ViewportInfo) => void;
  private readonly onError?: (error: RustDeskError) => void;
  private element?: HTMLTextAreaElement;
  private enabledValue: boolean;
  private composing = false;
  private suppressInput = false;
  private suppressTimer: ReturnType<typeof setTimeout> | undefined;
  private lastViewport: ViewportInfo | undefined;

  constructor(options: ImeInputOptions) {
    this.channel = options.channel;
    this.providedElement = options.element;
    this.container = options.container;
    this.enabledValue = options.enabled ?? true;
    this.onFocusChange = options.onFocusChange;
    this.onViewportChange = options.onViewportChange;
    this.onError = options.onError;
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  get focused(): boolean {
    return typeof document !== 'undefined' && document.activeElement === this.element;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabledValue) return;
    if (!enabled) {
      this.element?.blur();
      this.reset();
    }
    this.enabledValue = enabled;
  }

  attach(): void {
    if (this.element || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    if (this.providedElement) {
      this.element = this.providedElement;
    } else {
      this.element = hiddenTextarea(document);
      (this.container ?? document.body).append(this.element);
    }
    const element = this.element;
    element.addEventListener('focus', this.onFocus);
    element.addEventListener('blur', this.onBlur);
    element.addEventListener('input', this.onInput);
    element.addEventListener('compositionstart', this.onCompositionStart);
    element.addEventListener('compositionend', this.onCompositionEnd);
    element.addEventListener('paste', this.onPaste);
    if (this.onViewportChange) {
      window.addEventListener('resize', this.onViewport);
      window.visualViewport?.addEventListener('resize', this.onViewport);
      window.visualViewport?.addEventListener('scroll', this.onViewport);
      this.notifyViewport();
    }
  }

  detach(): void {
    const element = this.element;
    if (!element) return;
    element.removeEventListener('focus', this.onFocus);
    element.removeEventListener('blur', this.onBlur);
    element.removeEventListener('input', this.onInput);
    element.removeEventListener('compositionstart', this.onCompositionStart);
    element.removeEventListener('compositionend', this.onCompositionEnd);
    element.removeEventListener('paste', this.onPaste);
    element.blur();
    if (!this.providedElement) element.remove();
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onViewport);
      window.visualViewport?.removeEventListener('resize', this.onViewport);
      window.visualViewport?.removeEventListener('scroll', this.onViewport);
    }
    this.reset();
    this.element = undefined;
    this.lastViewport = undefined;
  }

  dispose(): void {
    this.detach();
    this.enabledValue = false;
  }

  /**
   * Focus the hidden textarea. Call only from a user gesture (button/tap);
   * `preventScroll` keeps the soft keyboard from scrolling the page.
   */
  focus(): boolean {
    const element = this.element;
    if (!this.enabledValue || !element) return false;
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
    return document.activeElement === element;
  }

  /** Send text (IME, paste, or the P3-5 clipboard fallback). */
  sendText(text: string): void {
    if (!this.enabledValue || !text) return;
    this.send({
      seq: text,
      mode: KeyboardMode.Translate,
      down: true,
      press: false,
      modifiers: [],
    });
  }

  private readonly onFocus = (): void => {
    if (this.element) this.element.value = '';
    this.callFocusChange(true);
  };

  private readonly onBlur = (): void => {
    this.reset();
    this.callFocusChange(false);
  };

  private readonly onInput = (event: Event): void => {
    if (!this.enabledValue) return;
    const input = event as InputEvent;
    if (this.composing || input.isComposing || this.suppressInput) return;
    const type = input.inputType;
    if (type === 'deleteContentBackward' || type === 'deleteContentForward') {
      // SwiftKey edits its hidden field and fires only this event for a
      // deletion (data: null, value: the remaining text). The keydown is
      // owned by KeyboardInput; resending the remaining value here would
      // duplicate or corrupt the remote text.
      if (this.element) this.element.value = '';
      return;
    }
    if (type === 'insertLineBreak' || type === 'insertParagraph') {
      // Enter is a control key; KeyboardInput sends it from the keydown.
      if (this.element) this.element.value = '';
      return;
    }
    // Some IMEs omit `data` but leave the inserted text in the field.
    const text = input.data ?? this.element?.value ?? '';
    if (this.element) this.element.value = '';
    if (text) this.sendText(text);
  };

  private readonly onCompositionStart = (): void => {
    this.composing = true;
  };

  private readonly onCompositionEnd = (event: Event): void => {
    this.composing = false;
    const data = (event as CompositionEvent).data;
    const text = data || this.element?.value || '';
    if (this.element) this.element.value = '';
    this.suppressInput = true;
    if (this.suppressTimer !== undefined) clearTimeout(this.suppressTimer);
    this.suppressTimer = setTimeout(() => {
      this.suppressInput = false;
      this.suppressTimer = undefined;
    }, 0);
    if (text) this.sendText(text);
  };

  private readonly onPaste = (event: Event): void => {
    const text =
      (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    event.preventDefault();
    // Do not let a future document-level P3-5 paste handler double-send.
    event.stopPropagation();
    if (this.element) this.element.value = '';
    this.sendText(text);
  };

  private readonly onViewport = (): void => {
    this.notifyViewport();
  };

  private reset(): void {
    this.composing = false;
    this.suppressInput = false;
    if (this.suppressTimer !== undefined) {
      clearTimeout(this.suppressTimer);
      this.suppressTimer = undefined;
    }
    if (this.element) this.element.value = '';
  }

  private readViewport(): ViewportInfo | null {
    if (typeof window === 'undefined') return null;
    const viewport = window.visualViewport;
    if (viewport) {
      return {
        width: viewport.width,
        height: viewport.height,
        offsetTop: viewport.offsetTop,
        offsetLeft: viewport.offsetLeft,
        scale: viewport.scale,
      };
    }
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    };
  }

  private notifyViewport(): void {
    const viewport = this.readViewport();
    if (!viewport) return;
    const previous = this.lastViewport;
    if (
      previous &&
      previous.width === viewport.width &&
      previous.height === viewport.height &&
      previous.offsetTop === viewport.offsetTop &&
      previous.offsetLeft === viewport.offsetLeft &&
      previous.scale === viewport.scale
    ) {
      return;
    }
    this.lastViewport = viewport;
    try {
      this.onViewportChange?.(viewport);
    } catch {
      // Host callbacks must not break input handling.
    }
  }

  private callFocusChange(focused: boolean): void {
    try {
      this.onFocusChange?.(focused);
    } catch {
      // Host callbacks must not break input handling.
    }
  }

  private send(keyEvent: KeyEvent): void {
    try {
      this.channel.sendMessage({ key_event: keyEvent });
    } catch (cause) {
      this.report(
        new RustDeskError('connection-lost', 'Failed to send text input', {
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
