import { describe, expect, it } from 'vitest';
import {
  ClipboardController,
  zstdContentSize,
  type ClipboardControllerOptions,
  type RemoteClipboardEvent,
} from '../src/input/clipboard';
import {
  ClipboardFormat,
  KeyboardMode,
  Message,
  type DeepPartial,
} from '../src/protocol/message';
import { RustDeskError } from '../src/session/errors';
import {
  CLIPBOARD_ZSTD,
  clipBytesFromBase64,
} from '../test-fixtures/clipboard';

// P3-5 unit coverage: text filtering, zstd decode, echo suppression,
// Clipboard/seq sends, byte caps, browser clipboard permissions/gestures and
// lifecycle gates. Real iOS/Android clipboard behavior remains ⏳ 真机待验.

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function textMessage(text: string): Message {
  return Message.fromPartial({
    clipboard: {
      compress: false,
      content: enc(text),
      format: ClipboardFormat.Text,
    },
  });
}

function clipboardMessage(
  content: Uint8Array,
  format: ClipboardFormat = ClipboardFormat.Text,
  compress = false,
): Message {
  return Message.fromPartial({
    clipboard: { compress, content, format },
  });
}

interface RecordingChannel {
  messages: DeepPartial<Message>[];
  channel: ClipboardControllerOptions['channel'];
}

function recordingChannel(
  behavior: { failClipboard?: boolean; failAll?: boolean } = {},
): RecordingChannel {
  const messages: DeepPartial<Message>[] = [];
  return {
    messages,
    channel: {
      sendMessage(payload) {
        if (behavior.failAll || (behavior.failClipboard && payload.clipboard)) {
          throw new Error('relay closed');
        }
        messages.push(payload);
      },
    },
  };
}

function writeRecorder(): {
  writes: string[];
  clipboard: { writeText(text: string): Promise<void> };
} {
  const writes: string[] = [];
  return {
    writes,
    clipboard: {
      async writeText(text) {
        writes.push(text);
      },
    },
  };
}

describe('ClipboardController', () => {
  it('decodes UTF-8 text and auto-copies it', async () => {
    const events: RemoteClipboardEvent[] = [];
    const { channel, messages } = recordingChannel();
    const { writes, clipboard } = writeRecorder();
    const controller = new ClipboardController({
      channel,
      clipboard,
      onRemoteText: (event) => events.push(event),
    });

    await controller.handleMessage(textMessage('远端 hello'));

    expect(events).toEqual([{ text: '远端 hello', copied: true }]);
    expect(writes).toEqual(['远端 hello']);
    expect(controller.lastRemoteText).toBe('远端 hello');
    expect(messages).toEqual([]);
  });

  it('ignores non-text, empty and unrelated messages', async () => {
    const events: RemoteClipboardEvent[] = [];
    const { writes, clipboard } = writeRecorder();
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      clipboard,
      onRemoteText: (event) => events.push(event),
    });

    await controller.handleMessage(Message.fromPartial({}));
    await controller.handleMessage(
      clipboardMessage(enc('png'), ClipboardFormat.ImagePng),
    );
    await controller.handleMessage(textMessage(''));

    expect(events).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('accepts the Text entry from a MultiClipboards payload', async () => {
    const events: RemoteClipboardEvent[] = [];
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      autoCopy: false,
      onRemoteText: (event) => events.push(event),
    });

    await controller.handleMessage(
      Message.fromPartial({
        multi_clipboards: {
          clipboards: [
            {
              compress: false,
              content: enc('<b>x</b>'),
              format: ClipboardFormat.Html,
            },
            {
              compress: false,
              content: enc('multi text'),
              format: ClipboardFormat.Text,
            },
          ],
        },
      }),
    );

    expect(events).toEqual([{ text: 'multi text', copied: false }]);
  });

  it('decompresses a zstd frame with a declared content size', async () => {
    const events: RemoteClipboardEvent[] = [];
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      autoCopy: false,
      onRemoteText: (event) => events.push(event),
    });

    await controller.handleMessage(
      clipboardMessage(
        clipBytesFromBase64(CLIPBOARD_ZSTD.knownSizeBase64),
        ClipboardFormat.Text,
        true,
      ),
    );

    expect(events).toEqual([{ text: CLIPBOARD_ZSTD.text, copied: false }]);
  });

  it('rejects streaming zstd frames without a declared size', async () => {
    const errors: RustDeskError[] = [];
    const events: RemoteClipboardEvent[] = [];
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      autoCopy: false,
      onRemoteText: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });

    await controller.handleMessage(
      clipboardMessage(
        clipBytesFromBase64(CLIPBOARD_ZSTD.streamBase64),
        ClipboardFormat.Text,
        true,
      ),
    );

    expect(events).toEqual([]);
    expect(errors[0]?.code).toBe('protocol-error');
  });

  it('rejects a zstd frame whose declared size does not match', async () => {
    const corrupt = clipBytesFromBase64(CLIPBOARD_ZSTD.knownSizeBase64);
    // The frame declares 30 bytes but decodes to 21; zstddec does not expose
    // ZSTD_isError, so the declared size is how we detect the silent failure.
    corrupt[5] = 30;
    const errors: RustDeskError[] = [];
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      autoCopy: false,
      onError: (error) => errors.push(error),
    });

    await controller.handleMessage(
      clipboardMessage(corrupt, ClipboardFormat.Text, true),
    );

    expect(errors[0]?.code).toBe('protocol-error');
  });

  it('rejects invalid UTF-8 and malformed compressed data', async () => {
    const errors: RustDeskError[] = [];
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      autoCopy: false,
      onError: (error) => errors.push(error),
    });

    await controller.handleMessage(
      clipboardMessage(Uint8Array.from([0xff, 0xfe])),
    );
    await controller.handleMessage(
      clipboardMessage(
        Uint8Array.from([1, 2, 3, 4, 5]),
        ClipboardFormat.Text,
        true,
      ),
    );

    expect(errors.map((error) => error.code)).toEqual([
      'protocol-error',
      'protocol-error',
    ]);
  });

  it('enforces the byte cap in both directions', async () => {
    const errors: RustDeskError[] = [];
    const { channel, messages } = recordingChannel();
    const controller = new ClipboardController({
      channel,
      autoCopy: false,
      maxTextBytes: 10,
      onError: (error) => errors.push(error),
    });

    await controller.handleMessage(textMessage('12345678901'));
    await controller.handleMessage(
      clipboardMessage(
        clipBytesFromBase64(CLIPBOARD_ZSTD.knownSizeBase64),
        ClipboardFormat.Text,
        true,
      ),
    );
    expect(controller.sendText('12345678901')).toBe(false);

    expect(errors.map((error) => error.code)).toEqual([
      'message-too-large',
      'message-too-large',
      'message-too-large',
    ]);
    expect(messages).toEqual([]);
  });

  it('deduplicates repeated text and suppresses echoes', async () => {
    const events: RemoteClipboardEvent[] = [];
    const { channel, messages } = recordingChannel();
    const { writes, clipboard } = writeRecorder();
    const controller = new ClipboardController({
      channel,
      clipboard,
      onRemoteText: (event) => events.push(event),
    });

    await controller.handleMessage(textMessage('same'));
    await controller.handleMessage(textMessage('same'));
    expect(controller.sendText('same')).toBe(false);

    expect(controller.sendText('local')).toBe(true);
    await controller.handleMessage(textMessage('local'));
    expect(controller.sendText('local')).toBe(false);

    expect(events).toEqual([{ text: 'same', copied: true }]);
    expect(writes).toEqual(['same']);
    expect(messages.filter((message) => message.clipboard)).toHaveLength(1);
  });

  it('sends local text as a Text clipboard message', () => {
    const { channel, messages } = recordingChannel();
    const controller = new ClipboardController({ channel });

    expect(controller.sendText('本地文本')).toBe(true);

    expect(messages).toHaveLength(1);
    const clipboard = messages[0]?.clipboard;
    expect(clipboard?.format).toBe(ClipboardFormat.Text);
    expect(clipboard?.compress).toBe(false);
    expect(dec(clipboard?.content ?? new Uint8Array())).toBe('本地文本');
  });

  it('falls back to Translate seq when the Clipboard message fails', () => {
    const { channel, messages } = recordingChannel({ failClipboard: true });
    const controller = new ClipboardController({ channel });

    expect(controller.sendText('fallback')).toBe(true);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.key_event).toMatchObject({
      seq: 'fallback',
      mode: KeyboardMode.Translate,
      down: true,
      press: false,
      modifiers: [],
    });
  });

  it('uses a custom seq sender and reports when both paths fail', () => {
    const seq: string[] = [];
    const custom = new ClipboardController({
      channel: recordingChannel({ failClipboard: true }).channel,
      sendSeq: (text) => seq.push(text),
    });
    expect(custom.sendText('custom')).toBe(true);
    expect(seq).toEqual(['custom']);

    const errors: RustDeskError[] = [];
    const failing = new ClipboardController({
      channel: recordingChannel({ failAll: true }).channel,
      onError: (error) => errors.push(error),
    });
    expect(failing.sendText('lost')).toBe(false);
    expect(errors[0]?.code).toBe('connection-lost');
  });

  it('does not report a rejected automatic copy and retries manually', async () => {
    const errors: RustDeskError[] = [];
    const events: RemoteClipboardEvent[] = [];
    const writes: string[] = [];
    let attempts = 0;
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      clipboard: {
        async writeText(text) {
          if (attempts++ === 0) throw new Error('NotAllowedError');
          writes.push(text);
        },
      },
      onRemoteText: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });

    await controller.handleMessage(textMessage('remote'));
    expect(events).toEqual([{ text: 'remote', copied: false }]);
    expect(errors).toEqual([]);

    expect(await controller.copyRemoteText()).toBe(true);
    expect(writes).toEqual(['remote']);
    expect(errors).toEqual([]);
  });

  it('reports manual copy failures and no-ops without remote text', async () => {
    const errors: RustDeskError[] = [];
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      clipboard: {
        async writeText() {
          throw new Error('NotAllowedError');
        },
      },
      autoCopy: false,
      onError: (error) => errors.push(error),
    });

    expect(await controller.copyRemoteText()).toBe(false);
    expect(errors).toEqual([]);

    await controller.handleMessage(textMessage('remote'));
    expect(await controller.copyRemoteText()).toBe(false);
    expect(errors[0]?.code).toBe('clipboard-unavailable');
    expect(errors).toHaveLength(1);
  });

  it('reads and sends the browser clipboard only from an enabled controller', async () => {
    let reads = 0;
    const { channel, messages } = recordingChannel();
    const controller = new ClipboardController({
      channel,
      clipboard: {
        async readText() {
          reads += 1;
          return '本地剪贴板';
        },
        async writeText() {},
      },
    });

    expect(await controller.sendLocalClipboard()).toBe(true);
    expect(reads).toBe(1);
    expect(dec(messages[0]?.clipboard?.content ?? new Uint8Array())).toBe(
      '本地剪贴板',
    );

    controller.setEnabled(false);
    expect(await controller.sendLocalClipboard()).toBe(false);
    expect(reads).toBe(1);
  });

  it('reports browser clipboard read failures', async () => {
    const errors: RustDeskError[] = [];
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      clipboard: {
        async readText() {
          throw new Error('NotAllowedError');
        },
        async writeText() {},
      },
      onError: (error) => errors.push(error),
    });

    expect(await controller.sendLocalClipboard()).toBe(false);
    expect(errors[0]?.code).toBe('clipboard-unavailable');
  });

  it('honours receiveEnabled and dispose', async () => {
    const events: RemoteClipboardEvent[] = [];
    const { writes, clipboard } = writeRecorder();
    const { channel, messages } = recordingChannel();
    const controller = new ClipboardController({
      channel,
      clipboard,
      receiveEnabled: false,
      onRemoteText: (event) => events.push(event),
    });

    await controller.handleMessage(textMessage('ignored'));
    expect(events).toEqual([]);
    expect(writes).toEqual([]);

    controller.setReceiveEnabled(true);
    await controller.handleMessage(textMessage('accepted'));
    expect(events).toHaveLength(1);

    controller.setEnabled(false);
    expect(controller.sendText('blocked')).toBe(false);
    expect(messages).toEqual([]);

    controller.dispose();
    await controller.handleMessage(textMessage('after dispose'));
    expect(events).toHaveLength(1);
    expect(controller.sendText('after dispose')).toBe(false);
    expect(await controller.copyRemoteText()).toBe(false);
  });
});

describe('zstdContentSize', () => {
  const frame = (descriptor: number, fcs: number[]): Uint8Array =>
    Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, descriptor, ...fcs, 0, 0, 0, 0]);

  it('reads 1/2/4/8-byte content sizes and rejects unknown/invalid frames', () => {
    expect(
      zstdContentSize(clipBytesFromBase64(CLIPBOARD_ZSTD.knownSizeBase64)),
    ).toBe(enc(CLIPBOARD_ZSTD.text).length);
    // 2-byte FCS stores size - 256; 4-byte and 8-byte store the size.
    expect(zstdContentSize(frame(0x60, [44, 0]))).toBe(300);
    expect(zstdContentSize(frame(0xa0, [0x70, 0x11, 0x01, 0x00]))).toBe(70_000);
    expect(zstdContentSize(frame(0xe0, [5, 0, 0, 0, 0, 0, 0, 0]))).toBe(5);
    expect(
      zstdContentSize(clipBytesFromBase64(CLIPBOARD_ZSTD.streamBase64)),
    ).toBeNull();
    expect(zstdContentSize(Uint8Array.from([1, 2, 3, 4, 5]))).toBeNull();
  });
});
