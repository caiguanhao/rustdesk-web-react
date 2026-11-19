/**
 * Two-way text clipboard (P3-5).
 *
 * Inbound `Message.clipboard` / `Message.multi_clipboards` is filtered to
 * `ClipboardFormat.Text`, optionally decompressed with zstd and decoded as
 * UTF-8. By default the text is written to the browser clipboard
 * automatically; browsers may reject that without a user gesture (notably
 * iOS), so the callback reports `copied: false` and the viewer can offer a
 * manual "copy" button that calls `copyRemoteText()` from a click.
 *
 * Outbound text is sent as `Clipboard{format:Text, content:utf8}`. That
 * message makes the peer's server call `update_clipboard`, so it sets the
 * remote clipboard without typing. If that send throws (transport failure),
 * the controller falls back to `KeyEvent{seq, mode:Translate}`. The fallback
 * cannot observe a peer that silently ignores clipboard (permission off), so
 * P4-1 must choose the message type from permission state and should inject
 * `sendSeq` from its keyboard-gated sender. Reading the local clipboard with
 * `navigator.clipboard.readText()` requires a user gesture; the viewer calls
 * `sendLocalClipboard()` from a click.
 *
 * This is a message handler, not a session: P4-1 owns the `nextMessage()`
 * loop and passes every message to `handleMessage()`. There are no DOM
 * listeners, so a headless session can construct it safely.
 *
 * Echo/loop suppression keeps one `lastSynced` value: a peer that echoes our
 * own clipboard back does not re-trigger a copy, and re-sending the same text
 * is a no-op. Empty text is ignored (MVP does not clear clipboards). Text
 * above `maxTextBytes` (default 4 MiB; upstream accepts 256 MiB) is rejected
 * with `message-too-large` to bound browser memory.
 *
 * zstddec is imported dynamically and initialised once, so the WASM decoder
 * is only fetched when a compressed clipboard actually arrives. RustDesk's
 * one-shot bulk compressor records the uncompressed size in the frame; a
 * frame without it is rejected instead of trusting zstddec's broken
 * `ZSTD_findDecompressedSize` path. Invalid UTF-8 is rejected (RustDesk's
 * peer uses `String::from_utf8`, not lossy decoding).
 */
import type { RelayConnection } from '../protocol/connection.js';
import {
  ClipboardFormat,
  KeyboardMode,
  type Clipboard as ClipboardPayload,
  type Message,
} from '../protocol/message.js';
import type { ZSTDDecoder } from 'zstddec';
import { RustDeskError } from '../session/errors.js';

export type ClipboardChannel = Pick<RelayConnection, 'sendMessage'>;

/** Browser clipboard subset; injected in tests/headless environments. */
export interface ClipboardAdapter {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface RemoteClipboardEvent {
  text: string;
  /** True when the controller also wrote the text to the browser clipboard. */
  copied: boolean;
}

export interface ClipboardControllerOptions {
  channel: ClipboardChannel;
  /**
   * Local→remote gate. P4-1 should derive it from `!readOnly` AND the peer's
   * clipboard **and** keyboard permissions (upstream `is_text_clipboard_required`).
   * Default true; disabling stops sends and local clipboard reads.
   */
  enabled?: boolean;
  /**
   * Remote→local gate. P4-1 should clear it for local view-only or
   * disable-clipboard (upstream gates inbound on those local flags, not on the
   * peer's clipboard permission). Default true; disabling ignores inbound
   * messages, including auto-copy.
   */
  receiveEnabled?: boolean;
  /** Try `navigator.clipboard.writeText` for inbound text. Default true. */
  autoCopy?: boolean;
  /**
   * Decompressed/plain UTF-8 byte cap; default 4 MiB. RustDesk desktop
   * accepts up to 256 MiB, but an unbounded browser string is a memory
   * hazard. Raise this option if real clipboards exceed the default.
   */
  maxTextBytes?: number;
  /** Overrides `navigator.clipboard` (tests, non-browser hosts). */
  clipboard?: Partial<ClipboardAdapter>;
  /**
   * Fallback when the Clipboard message send throws (transport failure).
   * P4-1 should inject a keyboard-permission-gated sender; the default sends
   * `KeyEvent.seq` on the same channel. A peer that silently ignores a
   * clipboard message (permission off) is not observable — choose the message
   * type from permission state instead of relying on this fallback.
   */
  sendSeq?: (text: string) => void;
  /** Called once per accepted remote text, after the auto-copy attempt. */
  onRemoteText?: (event: RemoteClipboardEvent) => void;
  onError?: (error: RustDeskError) => void;
}

export const DEFAULT_MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;
const DICT_ID_SIZES = [0, 1, 2, 4] as const;
const FCS_SIZES = [2, 4, 8] as const;

/**
 * Read the uncompressed size from a zstd frame header, or null when the
 * frame omits it (ZSTD_CONTENTSIZE_UNKNOWN). The size is required so
 * zstddec's broken `ZSTD_findDecompressedSize` path is never used.
 */
export function zstdContentSize(content: Uint8Array): number | null {
  if (content.length < 5) return null;
  const view = new DataView(
    content.buffer,
    content.byteOffset,
    content.byteLength,
  );
  let offset = 0;
  for (;;) {
    if (offset + 4 > content.length) return null;
    const magic = view.getUint32(offset, true);
    if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
      if (offset + 8 > content.length) return null;
      offset += 8 + view.getUint32(offset + 4, true);
      continue;
    }
    if (magic !== ZSTD_MAGIC) return null;
    break;
  }
  if (offset + 5 > content.length) return null;

  const descriptor = content[offset + 4]!;
  const singleSegment = (descriptor >> 5) & 1;
  const fcsFlag = descriptor >> 6;
  const dictFlag = descriptor & 3;
  let cursor = offset + 5;
  if (!singleSegment) cursor += 1;
  cursor += DICT_ID_SIZES[dictFlag]!;
  const fcsSize =
    fcsFlag === 0 ? (singleSegment ? 1 : 0) : FCS_SIZES[fcsFlag - 1]!;
  if (fcsSize === 0 || cursor + fcsSize > content.length) return null;

  switch (fcsSize) {
    case 1:
      return content[cursor]!;
    case 2:
      return view.getUint16(cursor, true) + 256;
    case 4:
      return view.getUint32(cursor, true);
    default: {
      const size = view.getBigUint64(cursor, true);
      return size > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(size);
    }
  }
}

let decoderPromise: Promise<ZSTDDecoder> | undefined;

function loadZstdDecoder(): Promise<ZSTDDecoder> {
  if (!decoderPromise) {
    decoderPromise = import('zstddec').then(async ({ ZSTDDecoder }) => {
      const decoder = new ZSTDDecoder();
      await decoder.init();
      return decoder;
    });
    // A failed load may be transient (CSP/asset retry); allow the next
    // compressed clipboard to try again.
    decoderPromise.catch(() => {
      decoderPromise = undefined;
    });
  }
  return decoderPromise;
}

function textClipboard(message: Message): ClipboardPayload | undefined {
  if (message.clipboard?.format === ClipboardFormat.Text) {
    return message.clipboard;
  }
  return message.multi_clipboards?.clipboards.find(
    (clipboard) => clipboard.format === ClipboardFormat.Text,
  );
}

function asClipboardError(error: unknown): RustDeskError {
  if (error instanceof RustDeskError) return error;
  return new RustDeskError('protocol-error', 'Failed to decode clipboard text', {
    cause: error,
  });
}

export class ClipboardController {
  private readonly channel: ClipboardChannel;
  private readonly injectedClipboard?: Partial<ClipboardAdapter>;
  private readonly sendSeq?: (text: string) => void;
  private readonly onRemoteText?: (event: RemoteClipboardEvent) => void;
  private readonly onError?: (error: RustDeskError) => void;
  private readonly maxTextBytes: number;
  private enabledValue: boolean;
  private receiveEnabledValue: boolean;
  private autoCopyValue: boolean;
  private disposed = false;
  private lastSynced: string | undefined;
  private remoteText: string | undefined;
  private inbound: Promise<void> = Promise.resolve();

  constructor(options: ClipboardControllerOptions) {
    this.channel = options.channel;
    this.enabledValue = options.enabled ?? true;
    this.receiveEnabledValue = options.receiveEnabled ?? true;
    this.autoCopyValue = options.autoCopy ?? true;
    this.injectedClipboard = options.clipboard;
    this.sendSeq = options.sendSeq;
    this.onRemoteText = options.onRemoteText;
    this.onError = options.onError;
    const max = options.maxTextBytes;
    this.maxTextBytes =
      max !== undefined && Number.isFinite(max) && max > 0
        ? Math.max(1, Math.floor(max))
        : DEFAULT_MAX_CLIPBOARD_BYTES;
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  get receiveEnabled(): boolean {
    return this.receiveEnabledValue;
  }

  get autoCopy(): boolean {
    return this.autoCopyValue;
  }

  /** Last text accepted from the peer (also usable after auto-copy fails). */
  get lastRemoteText(): string | undefined {
    return this.remoteText;
  }

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
  }

  setReceiveEnabled(enabled: boolean): void {
    this.receiveEnabledValue = enabled;
  }

  setAutoCopy(enabled: boolean): void {
    this.autoCopyValue = enabled;
  }

  /**
   * Accept one inbound protocol message. Non-text/non-clipboard messages are
   * ignored. Processing is serialised so auto-copy callbacks stay in order.
   * Errors are reported through `onError`; the returned promise never
   * rejects for a malformed clipboard payload.
   */
  handleMessage(message: Message): Promise<void> {
    if (this.disposed || !this.receiveEnabledValue) return Promise.resolve();
    const payload = textClipboard(message);
    if (!payload) return Promise.resolve();
    const next = this.inbound.then(() => this.processInbound(payload));
    this.inbound = next.catch(() => undefined);
    return next;
  }

  /**
   * Send local text to the peer clipboard. Returns false for empty text, a
   * disabled controller, a duplicate/echo, or when both the Clipboard
   * message and the seq fallback fail. Call from a user gesture when the
   * text comes from the browser clipboard.
   */
  sendText(text: string): boolean {
    if (this.disposed || !this.enabledValue || !text) return false;
    if (text === this.lastSynced) return false;
    // UTF-8 is never shorter than UTF-16 code units, so this rejects huge
    // strings before allocating an encoded copy.
    if (text.length > this.maxTextBytes) {
      this.reportClipboardTooLarge();
      return false;
    }
    const content = utf8.encode(text);
    if (content.length > this.maxTextBytes) {
      this.reportClipboardTooLarge();
      return false;
    }

    try {
      this.channel.sendMessage({
        clipboard: {
          compress: false,
          content,
          format: ClipboardFormat.Text,
        },
      });
    } catch (cause) {
      try {
        this.sendSeqText(text);
      } catch (fallbackCause) {
        this.report(
          new RustDeskError(
            'connection-lost',
            'Failed to send clipboard text',
            { cause: fallbackCause },
          ),
        );
        return false;
      }
    }
    this.lastSynced = text;
    return true;
  }

  /**
   * Read the browser clipboard and send it to the peer. Must be called from a
   * user gesture; reports `clipboard-unavailable` when reading is denied.
   */
  async sendLocalClipboard(): Promise<boolean> {
    if (this.disposed || !this.enabledValue) return false;
    const clipboard = this.browserClipboard();
    if (!clipboard?.readText) {
      this.reportClipboardUnavailable('Cannot read the browser clipboard');
      return false;
    }
    let text: string;
    try {
      text = await clipboard.readText();
    } catch (cause) {
      this.reportClipboardUnavailable(
        'Cannot read the browser clipboard',
        cause,
      );
      return false;
    }
    if (this.disposed || !this.enabledValue) return false;
    return this.sendText(text);
  }

  /**
   * Write the last remote text to the browser clipboard. The viewer's manual
   * "copy" button should call this from a click so Safari/iOS accept the
   * write. Returns false when there is no remote text or the API is
   * unavailable.
   */
  async copyRemoteText(): Promise<boolean> {
    const text = this.remoteText;
    if (!text || this.disposed) return false;
    return this.writeClipboard(text, true);
  }

  /** Clear dedupe/remote text for a reconnect; gates/local settings stay. */
  reset(): void {
    this.lastSynced = undefined;
    this.remoteText = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.enabledValue = false;
    this.receiveEnabledValue = false;
    this.lastSynced = undefined;
    this.remoteText = undefined;
  }

  private async processInbound(payload: ClipboardPayload): Promise<void> {
    if (this.disposed || !this.receiveEnabledValue) return;
    let text: string;
    try {
      text = await this.decodeText(payload);
    } catch (error) {
      this.report(asClipboardError(error));
      return;
    }
    if (this.disposed || !this.receiveEnabledValue) return;
    if (!text || text === this.lastSynced) return;

    this.lastSynced = text;
    this.remoteText = text;
    let copied = false;
    if (this.autoCopyValue) copied = await this.writeClipboard(text, false);
    if (this.disposed || !this.receiveEnabledValue) return;
    try {
      this.onRemoteText?.({ text, copied });
    } catch {
      // Host callbacks must not break message handling.
    }
  }

  private async decodeText(payload: ClipboardPayload): Promise<string> {
    const max = this.maxTextBytes;
    if (payload.content.length > max) {
      throw new RustDeskError(
        'message-too-large',
        `Clipboard content exceeds ${max} bytes`,
      );
    }

    let content = payload.content;
    if (payload.compress) {
      const size = zstdContentSize(content);
      if (size === null) {
        throw new RustDeskError(
          'protocol-error',
          'Clipboard zstd frame does not declare its uncompressed size',
        );
      }
      if (size > max) {
        throw new RustDeskError(
          'message-too-large',
          `Clipboard text exceeds ${max} bytes`,
        );
      }
      if (size === 0) return '';

      let decoder: ZSTDDecoder;
      try {
        decoder = await loadZstdDecoder();
      } catch (cause) {
        throw new RustDeskError(
          'asset-load-failed',
          'Failed to load the clipboard zstd decoder',
          { cause },
        );
      }

      try {
        content = decoder.decode(content, size);
      } catch (cause) {
        throw new RustDeskError(
          'protocol-error',
          'Failed to decompress clipboard text',
          { cause },
        );
      }
      // zstddec does not call ZSTD_isError; a corrupt frame is returned as
      // an empty/truncated array. The declared size lets us detect it.
      if (content.length !== size) {
        throw new RustDeskError(
          'protocol-error',
          'Clipboard zstd frame produced an unexpected size',
        );
      }
    }

    try {
      return utf8Decoder.decode(content);
    } catch (cause) {
      throw new RustDeskError(
        'protocol-error',
        'Clipboard text is not valid UTF-8',
        { cause },
      );
    }
  }

  private sendSeqText(text: string): void {
    if (this.sendSeq) {
      this.sendSeq(text);
      return;
    }
    this.channel.sendMessage({
      key_event: {
        seq: text,
        mode: KeyboardMode.Translate,
        down: true,
        press: false,
        modifiers: [],
      },
    });
  }

  private browserClipboard(): Partial<ClipboardAdapter> | undefined {
    if (this.injectedClipboard) return this.injectedClipboard;
    if (typeof navigator === 'undefined') return undefined;
    return navigator.clipboard;
  }

  private async writeClipboard(
    text: string,
    reportError: boolean,
  ): Promise<boolean> {
    const clipboard = this.browserClipboard();
    if (!clipboard?.writeText) {
      if (reportError) {
        this.reportClipboardUnavailable('Cannot write the browser clipboard');
      }
      return false;
    }
    try {
      await clipboard.writeText(text);
      return true;
    } catch (cause) {
      if (reportError) {
        this.reportClipboardUnavailable(
          'Cannot write the browser clipboard',
          cause,
        );
      }
      return false;
    }
  }

  private reportClipboardUnavailable(message: string, cause?: unknown): void {
    this.report(
      new RustDeskError(
        'clipboard-unavailable',
        message,
        cause === undefined ? undefined : { cause },
      ),
    );
  }

  private reportClipboardTooLarge(): void {
    this.report(
      new RustDeskError(
        'message-too-large',
        `Clipboard text exceeds ${this.maxTextBytes} bytes`,
      ),
    );
  }

  private report(error: RustDeskError): void {
    try {
      this.onError?.(error);
    } catch {
      // Host callbacks must not break clipboard handling.
    }
  }
}
