import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImeInput } from '../src/input/ime';
import { KeyboardMode } from '../src/protocol/message';
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

// P3-3 integration: composition/input/paste → ImeInput → encrypted relay →
// mock peer. Real iOS/Android IME behavior remains ⏳ 真机待验.

class FakeTextArea extends EventTarget {
  value = '';

  blur(): void {
    this.dispatchEvent(new Event('blur'));
  }
}

let dom: FakeDom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  dom.restore();
});

describe('IME input over the mock relay', () => {
  it('sends input, composition and paste text as Translate seq events', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    let relay: MockRelaySession | undefined;
    let ime: ImeInput | undefined;
    try {
      relay = await connectMockRelay(mock);
      const textarea = new FakeTextArea();
      ime = new ImeInput({
        channel: relay.connection,
        element: textarea as unknown as HTMLTextAreaElement,
      });
      ime.attach();

      dispatchDom(textarea, 'input', { data: 'a', isComposing: false });
      dispatchDom(textarea, 'compositionstart', { data: '' });
      dispatchDom(textarea, 'input', { data: '你', isComposing: true });
      dispatchDom(textarea, 'compositionend', { data: '你好' });
      dispatchDom(textarea, 'paste', {
        clipboardData: {
          getData: (type: string) => (type === 'text/plain' ? '粘贴' : ''),
        },
      });

      const keyEvents = () =>
        mock.inputs.flatMap((message) =>
          message.key_event ? [message.key_event] : [],
        );
      await waitFor(() => keyEvents().length === 3, 2000);
      expect(keyEvents().map((event) => event.seq)).toEqual([
        'a',
        '你好',
        '粘贴',
      ]);
      expect(
        keyEvents().every(
          (event) =>
            event.mode === KeyboardMode.Translate &&
            event.down === true &&
            event.press === false &&
            event.modifiers.length === 0,
        ),
      ).toBe(true);
      expect(textarea.value).toBe('');

      ime.setEnabled(false);
      dispatchDom(textarea, 'input', { data: 'b', isComposing: false });
      expect(keyEvents()).toHaveLength(3);
    } finally {
      ime?.dispose();
      relay?.close();
      await mock.close();
    }
  });
});
