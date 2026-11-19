// Playwright browser acceptance for P3-5: drives the real navigator.clipboard
// through ClipboardController, with a recording channel instead of a peer.
// The unit/mock-relay suites cover protocol bytes and zstd; this page proves
// the browser permission/user-gesture paths that Node cannot.
import {
  ClipboardController,
  type RemoteClipboardEvent,
} from '../../src/input/clipboard';
import {
  ClipboardFormat,
  Message,
  type DeepPartial,
} from '../../src/protocol/message';
import { bytesFromBase64, setStatus } from './check-harness';

export interface RecordedClipboard {
  format: ClipboardFormat;
  compress: boolean;
  text: string;
}

export interface ClipboardTestApi {
  ready: boolean;
  events: RemoteClipboardEvent[];
  errors: { code: string; message: string }[];
  messages: RecordedClipboard[];
  receivePlain(text: string): Promise<void>;
  receiveCompressed(base64: string): Promise<void>;
  sendLocalClipboard(): Promise<boolean>;
  copyRemoteText(): Promise<boolean>;
  setAutoCopy(enabled: boolean): void;
}

declare global {
  interface Window {
    clipboardTest?: ClipboardTestApi;
  }
}

const messages: RecordedClipboard[] = [];
const events: RemoteClipboardEvent[] = [];
const errors: { code: string; message: string }[] = [];

const channel = {
  sendMessage(payload: DeepPartial<Message>) {
    const clipboard = payload.clipboard;
    if (!clipboard) return;
    messages.push({
      format: clipboard.format ?? ClipboardFormat.Text,
      compress: clipboard.compress ?? false,
      text: new TextDecoder().decode(clipboard.content),
    });
  },
};

const controller = new ClipboardController({
  channel,
  onRemoteText: (event) => events.push(event),
  onError: (error) => errors.push({ code: error.code, message: error.message }),
});

const api: ClipboardTestApi = {
  ready: false,
  events,
  errors,
  messages,
  receivePlain: (text) =>
    controller.handleMessage(
      Message.fromPartial({
        clipboard: {
          compress: false,
          content: new TextEncoder().encode(text),
          format: ClipboardFormat.Text,
        },
      }),
    ),
  receiveCompressed: (base64) =>
    controller.handleMessage(
      Message.fromPartial({
        clipboard: {
          compress: true,
          content: bytesFromBase64(base64),
          format: ClipboardFormat.Text,
        },
      }),
    ),
  sendLocalClipboard: () => controller.sendLocalClipboard(),
  copyRemoteText: () => controller.copyRemoteText(),
  setAutoCopy: (enabled) => controller.setAutoCopy(enabled),
};
window.clipboardTest = api;

document.getElementById('send-local')?.addEventListener('click', () => {
  void api.sendLocalClipboard();
});
document.getElementById('copy-remote')?.addEventListener('click', () => {
  void api.copyRemoteText();
});

api.ready = true;
setStatus('ready');
