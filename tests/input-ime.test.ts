// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ImeInput,
  type ImeChannel,
  type ImeInputOptions,
  type ViewportInfo,
} from '../src/input/ime';
import {
  KeyboardMode,
  type DeepPartial,
  type KeyEvent,
  type Message,
} from '../src/protocol/message';
import { RustDeskError } from '../src/session/errors';

// P3-3 unit coverage: hidden textarea contract, plain input, composition
// ordering, paste, focus/disable/detach lifecycle, viewport notifications and
// send errors. Real iOS/Android IME behavior remains ⏳ 真机待验.

type SentKey = KeyEvent;

function fakeChannel(
  forward?: ImeChannel,
): ImeChannel & { sent: SentKey[] } {
  const sent: SentKey[] = [];
  return {
    sent,
    sendMessage(payload: DeepPartial<Message>) {
      if (payload.key_event) sent.push(payload.key_event as KeyEvent);
      forward?.sendMessage(payload);
    },
  };
}

const inputs: ImeInput[] = [];

function makeInput(
  options: Omit<Partial<ImeInputOptions>, 'channel'> = {},
  forward?: ImeChannel,
): { input: ImeInput; channel: ReturnType<typeof fakeChannel> } {
  const channel = fakeChannel(forward);
  const input = new ImeInput({ channel, ...options });
  inputs.push(input);
  return { input, channel };
}

function composition(type: string, data = ''): CompositionEvent {
  return new CompositionEvent(type, {
    data,
    bubbles: true,
    cancelable: true,
  });
}

function inputEvent(data: string | null, isComposing = false): InputEvent {
  return new InputEvent('input', {
    data,
    isComposing,
    bubbles: true,
    cancelable: true,
  });
}

function paste(text: string): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    configurable: true,
    value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
  });
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const input of inputs.splice(0)) input.dispose();
  delete (window as unknown as Record<string, unknown>).visualViewport;
});

describe('ImeInput', () => {
  it('creates a hidden, focusable 16px textarea and removes it on dispose', () => {
    const { input } = makeInput();
    input.attach();
    const element = document.querySelector('textarea');
    expect(element).not.toBeNull();
    expect(element?.style.position).toBe('fixed');
    expect(element?.style.width).toBe('1px');
    expect(element?.style.height).toBe('1px');
    expect(element?.style.opacity).toBe('0');
    expect(element?.style.fontSize).toBe('16px');
    expect(element?.style.display).not.toBe('none');
    expect(element?.tabIndex).toBe(-1);
    expect(element?.getAttribute('autocomplete')).toBe('off');

    expect(input.focus()).toBe(true);
    expect(input.focused).toBe(true);
    input.dispose();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('sends plain input as a Translate seq and clears the buffer', () => {
    const { input, channel } = makeInput();
    input.attach();
    input.focus();
    const element = document.querySelector('textarea')!;
    element.dispatchEvent(inputEvent('a'));
    expect(channel.sent).toEqual([
      {
        seq: 'a',
        mode: KeyboardMode.Translate,
        down: true,
        press: false,
        modifiers: [],
      },
    ]);
    expect(element.value).toBe('');
  });

  it('sends one seq for a composition and suppresses the trailing input', () => {
    const { input, channel } = makeInput();
    input.attach();
    const element = document.querySelector('textarea')!;
    input.focus();

    element.dispatchEvent(composition('compositionstart'));
    element.dispatchEvent(inputEvent('你', true));
    element.dispatchEvent(inputEvent('你好', true));
    element.dispatchEvent(composition('compositionend', '你好'));
    element.dispatchEvent(inputEvent('你好'));

    expect(channel.sent.map((event) => event.seq)).toEqual(['你好']);
    expect(element.value).toBe('');
  });

  it('falls back to the textarea value when compositionend has no data', () => {
    const { input, channel } = makeInput();
    input.attach();
    const element = document.querySelector('textarea')!;
    input.focus();
    element.dispatchEvent(composition('compositionstart'));
    element.value = '中文';
    element.dispatchEvent(inputEvent('中文', true));
    element.dispatchEvent(composition('compositionend', ''));
    expect(channel.sent.map((event) => event.seq)).toEqual(['中文']);
  });

  it('resumes plain input after the composition suppression window', async () => {
    const { input, channel } = makeInput();
    input.attach();
    const element = document.querySelector('textarea')!;
    input.focus();
    element.dispatchEvent(composition('compositionstart'));
    element.dispatchEvent(composition('compositionend', '好'));
    element.dispatchEvent(inputEvent('好'));
    expect(channel.sent).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    element.dispatchEvent(inputEvent('b'));
    expect(channel.sent.map((event) => event.seq)).toEqual(['好', 'b']);
  });

  it('sends pasted text synchronously, prevents insertion and stops bubbling', () => {
    const { input, channel } = makeInput();
    input.attach();
    input.focus();
    const parentPaste = vi.fn();
    document.body.addEventListener('paste', parentPaste);
    const event = paste('粘贴');
    document.querySelector('textarea')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(parentPaste).not.toHaveBeenCalled();
    expect(channel.sent.at(-1)).toMatchObject({
      seq: '粘贴',
      mode: KeyboardMode.Translate,
    });
  });

  it('reports focus changes and clears on blur', () => {
    const focus: boolean[] = [];
    const { input } = makeInput({
      onFocusChange: (focused) => focus.push(focused),
    });
    input.attach();
    const element = document.querySelector('textarea')!;
    element.value = 'x';
    input.focus();
    element.blur();
    expect(focus).toEqual([true, false]);
    expect(element.value).toBe('');
  });

  it('disables sends and blur when disabled, then re-enables', () => {
    const { input, channel } = makeInput();
    input.attach();
    input.focus();
    const element = document.querySelector('textarea')!;
    input.setEnabled(false);
    expect(input.focused).toBe(false);
    expect(input.focus()).toBe(false);
    element.dispatchEvent(inputEvent('a'));
    input.sendText('b');
    expect(channel.sent).toEqual([]);

    input.setEnabled(true);
    expect(input.focus()).toBe(true);
    element.dispatchEvent(inputEvent('c'));
    expect(channel.sent.map((event) => event.seq)).toEqual(['c']);
  });

  it('ignores empty text and non-text paste', () => {
    const { input, channel } = makeInput();
    input.attach();
    input.focus();
    input.sendText('');
    const event = paste('');
    document.querySelector('textarea')!.dispatchEvent(event);
    expect(channel.sent).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('uses a provided textarea without removing or restyling it', () => {
    const provided = document.createElement('textarea');
    document.body.append(provided);
    const { input } = makeInput({ element: provided });
    input.attach();
    expect(provided.style.position).toBe('');
    input.dispose();
    expect(document.body.contains(provided)).toBe(true);
  });

  it('detaches listeners and is idempotent', () => {
    const { input, channel } = makeInput();
    input.attach();
    input.attach();
    const element = document.querySelector('textarea')!;
    input.focus();
    input.detach();
    input.detach();
    element.dispatchEvent(inputEvent('a'));
    expect(channel.sent).toEqual([]);
  });

  it('notifies visual viewport changes', () => {
    const viewport = Object.assign(new EventTarget(), {
      width: 320,
      height: 200,
      offsetTop: 10,
      offsetLeft: 5,
      scale: 2,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });
    const changes: ViewportInfo[] = [];
    const { input } = makeInput({
      onViewportChange: (value) => changes.push(value),
    });
    input.attach();
    expect(changes.at(-1)).toEqual({
      width: 320,
      height: 200,
      offsetTop: 10,
      offsetLeft: 5,
      scale: 2,
    });
    viewport.width = 300;
    viewport.dispatchEvent(new Event('resize'));
    expect(changes.at(-1)?.width).toBe(300);
  });

  it('swallows focus callback errors and reports send failures', () => {
    const errors: RustDeskError[] = [];
    const channel: ImeChannel = {
      sendMessage() {
        throw new Error('relay closed');
      },
    };
    const { input } = makeInput(
      {
        onFocusChange: () => {
          throw new Error('host callback');
        },
        onError: (error) => errors.push(error),
      },
      channel,
    );
    input.attach();
    expect(() => input.focus()).not.toThrow();
    expect(() => input.sendText('x')).not.toThrow();
    expect(errors.map((error) => error.code)).toEqual(['connection-lost']);
  });
});
