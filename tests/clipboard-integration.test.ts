import { describe, expect, it } from 'vitest';
import { ClipboardController, type RemoteClipboardEvent } from '../src/input/clipboard';
import { ClipboardFormat } from '../src/protocol/message';
import {
  CLIPBOARD_ZSTD,
  clipBytesFromBase64,
} from '../test-fixtures/clipboard';
import {
  connectMockRelay,
  type MockRelaySession,
} from './mocks/relay-session';
import { MockRustDeskServer, waitFor } from './mocks/rustdesk-mock';

// P3-5 integration: peer Clipboard messages → controller → local callback,
// and local Clipboard messages → encrypted relay → mock controlled peer.
// Real browser/OS clipboard permissions remain ⏳ 真机待验.

describe('clipboard over the mock relay', () => {
  it('receives compressed/plain text and sends local text to the peer', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    let relay: MockRelaySession | undefined;
    let controller: ClipboardController | undefined;
    try {
      relay = await connectMockRelay(mock);
      const events: RemoteClipboardEvent[] = [];
      const clipboard = new ClipboardController({
        channel: relay.connection,
        autoCopy: false,
        onRemoteText: (event) => events.push(event),
      });
      controller = clipboard;

      void (async () => {
        for (;;) {
          const message = await relay!.connection.nextMessage(5000);
          await clipboard.handleMessage(message);
        }
      })().catch(() => undefined);

      mock.sendClipboard({
        compress: true,
        content: clipBytesFromBase64(CLIPBOARD_ZSTD.knownSizeBase64),
        format: ClipboardFormat.Text,
      });
      await waitFor(() => events.length === 1, 2000);
      expect(events[0]).toEqual({ text: CLIPBOARD_ZSTD.text, copied: false });

      mock.sendClipboard({
        compress: false,
        content: new TextEncoder().encode('plain remote'),
        format: ClipboardFormat.Text,
      });
      await waitFor(() => events.length === 2, 2000);
      expect(events[1]).toEqual({ text: 'plain remote', copied: false });

      expect(clipboard.sendText('本地文本')).toBe(true);
      await waitFor(
        () => mock.inputs.some((message) => message.clipboard),
        2000,
      );
      const sent = mock.inputs.find((message) => message.clipboard)?.clipboard;
      expect(sent?.format).toBe(ClipboardFormat.Text);
      expect(sent?.compress).toBe(false);
      expect(new TextDecoder().decode(sent?.content)).toBe('本地文本');
    } finally {
      controller?.dispose();
      relay?.close();
      await mock.close();
    }
  });
});
