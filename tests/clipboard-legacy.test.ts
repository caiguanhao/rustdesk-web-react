// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClipboardController,
  type ClipboardControllerOptions,
  type RemoteClipboardEvent,
} from '../src/input/clipboard';
import {
  ClipboardFormat,
  Message,
  type DeepPartial,
} from '../src/protocol/message';
import { RustDeskError } from '../src/session/errors';

// P3-5/P5-1: plain-HTTP LAN pages are not secure contexts, so
// navigator.clipboard does not exist. The legacy execCommand path keeps the
// manual copy affordance working there; the injected adapter must stay
// authoritative for tests/headless hosts.

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function textMessage(text: string): Message {
  return Message.fromPartial({
    clipboard: {
      compress: false,
      content: enc(text),
      format: ClipboardFormat.Text,
    },
  });
}

function recordingChannel(): {
  messages: DeepPartial<Message>[];
  channel: ClipboardControllerOptions['channel'];
} {
  const messages: DeepPartial<Message>[] = [];
  return {
    messages,
    channel: {
      sendMessage(payload) {
        messages.push(payload);
      },
    },
  };
}

function stubExecCommand(result: boolean): ReturnType<typeof vi.fn> {
  const exec = vi.fn(() => result);
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: exec,
  });
  return exec;
}

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).clipboard;
  delete (document as unknown as Record<string, unknown>).execCommand;
});

describe('legacy clipboard fallback', () => {
  it('copies inbound text with execCommand when navigator.clipboard is absent', async () => {
    const exec = stubExecCommand(true);
    const events: RemoteClipboardEvent[] = [];
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      onRemoteText: (event) => events.push(event),
    });

    await controller.handleMessage(textMessage('remote 文本'));
    expect(exec).toHaveBeenCalledWith('copy');
    expect(events).toEqual([{ text: 'remote 文本', copied: true }]);
    controller.dispose();
  });

  it('falls back to execCommand when writeText is denied', async () => {
    const exec = stubExecCommand(true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error('NotAllowedError');
        }),
      },
    });
    const events: RemoteClipboardEvent[] = [];
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      onRemoteText: (event) => events.push(event),
    });

    await controller.handleMessage(textMessage('remote'));
    expect(events).toEqual([{ text: 'remote', copied: true }]);
    expect(exec).toHaveBeenCalledWith('copy');
    controller.dispose();
  });

  it('reports clipboard-unavailable only for an explicit manual copy', async () => {
    stubExecCommand(false);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error('NotAllowedError');
        }),
      },
    });
    const events: RemoteClipboardEvent[] = [];
    const errors: RustDeskError[] = [];
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      onRemoteText: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });

    await controller.handleMessage(textMessage('remote'));
    expect(events).toEqual([{ text: 'remote', copied: false }]);
    expect(errors).toEqual([]);

    expect(await controller.copyRemoteText()).toBe(false);
    expect(errors[0]?.code).toBe('clipboard-unavailable');
    expect(errors).toHaveLength(1);
    controller.dispose();
  });

  it('keeps an injected clipboard adapter authoritative', async () => {
    const exec = stubExecCommand(true);
    const events: RemoteClipboardEvent[] = [];
    const controller = new ClipboardController({
      channel: recordingChannel().channel,
      clipboard: {
        readText: async () => '',
        writeText: async () => {
          throw new Error('NotAllowedError');
        },
      },
      onRemoteText: (event) => events.push(event),
    });

    await controller.handleMessage(textMessage('remote'));
    expect(events).toEqual([{ text: 'remote', copied: false }]);
    expect(exec).not.toHaveBeenCalled();
    controller.dispose();
  });
});
