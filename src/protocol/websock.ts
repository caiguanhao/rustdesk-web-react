/**
 * Binary WebSocket transport.
 *
 * RustDesk frames are self-delimiting at the WebSocket layer: one binary
 * message = one complete protobuf (`RendezvousMessage` during rendezvous,
 * `Message` over relay), with no length prefix and no transport compression.
 * This class therefore queues raw frames and decodes them on demand.
 *
 * Differences from v1 (`js/src/websock.ts`):
 * - No 1 ms polling: `next*` returns a queued frame immediately or waits on a
 *   promise with a deadline.
 * - Typed failures (`RustDeskError`) instead of strings, including the 1009
 *   "message too big" close code reverse proxies use.
 * - `setCipher` exposes a frame transform hook; P1-5 installs secretbox here
 *   for `Message` frames only (rendezvous frames are never encrypted).
 */
import { RustDeskError } from '../session/errors.js';
import * as message from './message.js';
import * as rendezvous from './rendezvous.js';
import type { DeepPartial as MessagePartial } from './message.js';
import type { DeepPartial as RendezvousPartial } from './rendezvous.js';

export const DEFAULT_OPEN_TIMEOUT_MS = 12_000;
export const DEFAULT_NEXT_TIMEOUT_MS = DEFAULT_OPEN_TIMEOUT_MS;

export interface WebSocketCloseInfo {
  code: number;
  reason: string;
  wasClean?: boolean;
}

/** Minimal WebSocket surface shared by the browser and the `ws` package. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onclose: ((event: WebSocketCloseInfo) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Applied after protobuf encoding and before protobuf decoding. */
export interface FrameCipher {
  encrypt(plain: Uint8Array): Uint8Array;
  decrypt(encrypted: Uint8Array): Uint8Array;
}

export interface WebSockOptions {
  /** Test/Node injection; defaults to `new WebSocket(url)`. */
  createSocket?: WebSocketFactory;
  openTimeoutMs?: number;
  nextTimeoutMs?: number;
}

export interface WebSockCloseEvent extends WebSocketCloseInfo {
  wasClean: boolean;
  /** True when `close()` initiated the shutdown. */
  local: boolean;
}

export interface WebSockEventMap {
  open: undefined;
  close: WebSockCloseEvent;
  error: RustDeskError;
  /** Raw frame as received (still encrypted when a cipher is installed). */
  message: Uint8Array;
}

type EventName = keyof WebSockEventMap;
type EventHandler<K extends EventName> = (payload: WebSockEventMap[K]) => void;

interface Waiter {
  resolve: (bytes: Uint8Array) => void;
  reject: (error: RustDeskError) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const CONNECTING = 0;
const OPEN = 1;

function defaultCreateSocket(url: string): WebSocketLike {
  if (typeof WebSocket === 'undefined') {
    throw new RustDeskError('invalid-config', 'WebSocket is not available in this environment');
  }
  try {
    return new WebSocket(url) as unknown as WebSocketLike;
  } catch (cause) {
    throw new RustDeskError('invalid-config', 'Invalid WebSocket URL', { cause });
  }
}

function asBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}

export class WebSock {
  readonly url: string;

  private readonly socket: WebSocketLike;
  private readonly openTimeoutMs: number;
  private readonly nextTimeoutMs: number;
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly handlers = new Map<EventName, Set<(payload: unknown) => void>>();
  private cipher: FrameCipher | undefined;
  private opened = false;
  private localClosed = false;
  private terminalError: RustDeskError | undefined;
  private openPromise: Promise<void> | undefined;
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private openResolve: (() => void) | undefined;
  private openReject: ((error: RustDeskError) => void) | undefined;

  constructor(url: string, options: WebSockOptions = {}) {
    this.url = url;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.nextTimeoutMs = options.nextTimeoutMs ?? DEFAULT_NEXT_TIMEOUT_MS;

    const createSocket = options.createSocket ?? defaultCreateSocket;
    try {
      this.socket = createSocket(url);
    } catch (cause) {
      if (cause instanceof RustDeskError) throw cause;
      throw new RustDeskError('invalid-config', 'Cannot create WebSocket', { cause });
    }

    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = () => this.handleOpen();
    this.socket.onmessage = (event) => this.handleMessage(event.data);
    this.socket.onerror = (event) => this.handleError(event);
    this.socket.onclose = (event) => this.handleClose(event);
  }

  /** Subscribe to a transport event; returns an unsubscribe function. */
  on<K extends EventName>(event: K, handler: EventHandler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const wrapped = handler as (payload: unknown) => void;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }

  /** Install (or clear) the frame transform used by `sendMessage`/`nextMessage`. */
  setCipher(cipher: FrameCipher | undefined): void {
    this.cipher = cipher;
  }

  /**
   * Resolve once the socket opens; reject with `server-unreachable`/`timeout`
   * otherwise. Subsequent calls share the same outcome.
   */
  open(timeoutMs = this.openTimeoutMs): Promise<void> {
    if (this.opened) return Promise.resolve();
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.openPromise) return this.openPromise;

    if (this.socket.readyState === OPEN) {
      this.handleOpen();
      return Promise.resolve();
    }

    this.openPromise = new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
      this.openTimer = setTimeout(() => {
        const error = new RustDeskError('timeout', `WebSocket did not open within ${timeoutMs} ms`);
        this.fail(error);
        this.detachSocket();
        try {
          this.socket.close(1000, 'open timeout');
        } catch {
          // The socket may already be gone.
        }
      }, timeoutMs);
    });
    return this.openPromise;
  }

  sendRendezvous(payload: RendezvousPartial<rendezvous.RendezvousMessage>): void {
    let bytes: Uint8Array;
    try {
      bytes = rendezvous.RendezvousMessage.encode(
        rendezvous.RendezvousMessage.fromPartial(payload),
      ).finish();
    } catch (cause) {
      throw new RustDeskError('protocol-error', 'Failed to encode RendezvousMessage', { cause });
    }
    this.sendBytes(bytes);
  }

  sendMessage(payload: MessagePartial<message.Message>): void {
    let bytes: Uint8Array;
    try {
      bytes = message.Message.encode(message.Message.fromPartial(payload)).finish();
    } catch (cause) {
      throw new RustDeskError('protocol-error', 'Failed to encode Message', { cause });
    }
    this.sendBytes(this.applyCipher(bytes, 'encrypt'));
  }

  /** Next raw frame, in arrival order. Does not decrypt. */
  nextRaw(timeoutMs = this.nextTimeoutMs): Promise<Uint8Array> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.terminalError) return Promise.reject(this.terminalError);

    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new RustDeskError('timeout', `No WebSocket message within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async nextRendezvous(
    timeoutMs = this.nextTimeoutMs,
  ): Promise<rendezvous.RendezvousMessage> {
    const bytes = await this.nextRaw(timeoutMs);
    try {
      return rendezvous.RendezvousMessage.decode(bytes);
    } catch (cause) {
      throw new RustDeskError('protocol-error', 'Failed to decode RendezvousMessage', { cause });
    }
  }

  async nextMessage(timeoutMs = this.nextTimeoutMs): Promise<message.Message> {
    const bytes = await this.nextRaw(timeoutMs);
    try {
      return message.Message.decode(this.applyCipher(bytes, 'decrypt'));
    } catch (cause) {
      throw new RustDeskError('protocol-error', 'Failed to decode Message', { cause });
    }
  }

  /** Close locally and reject pending/open waits with `aborted`. Idempotent. */
  close(code = 1000, reason = ''): void {
    if (this.localClosed) return;
    this.localClosed = true;

    const error = new RustDeskError('aborted', 'WebSocket closed locally');
    this.terminalError = error;
    this.settleOpen(error);
    this.rejectWaiters(error);
    this.detachSocket();

    try {
      if (this.socket.readyState === CONNECTING || this.socket.readyState === OPEN) {
        this.socket.close(code, reason);
      }
    } catch {
      // Closing an already-broken socket is not an error for callers.
    }

    this.emit('close', { code, reason, wasClean: true, local: true });
  }

  private applyCipher(bytes: Uint8Array, direction: 'encrypt' | 'decrypt'): Uint8Array {
    if (!this.cipher) return bytes;
    try {
      return this.cipher[direction](bytes);
    } catch (cause) {
      // P1-5's cipher raises typed errors (bad key/tampered frame); keep them.
      if (cause instanceof RustDeskError) throw cause;
      throw new RustDeskError('protocol-error', `Failed to ${direction} WebSocket frame`, {
        cause,
      });
    }
  }

  /** Record the first terminal failure and settle every pending wait. */
  private fail(error: RustDeskError): RustDeskError {
    if (!this.terminalError) this.terminalError = error;
    this.settleOpen(error);
    this.rejectWaiters(this.terminalError);
    return this.terminalError;
  }

  private sendBytes(bytes: Uint8Array): void {
    if (this.localClosed) {
      throw new RustDeskError('aborted', 'WebSocket closed locally');
    }
    if (this.terminalError) throw this.terminalError;
    if (this.socket.readyState !== OPEN) {
      throw new RustDeskError('connection-lost', 'WebSocket is not open');
    }
    try {
      this.socket.send(bytes);
    } catch (cause) {
      throw new RustDeskError('connection-lost', 'Failed to send WebSocket frame', { cause });
    }
  }

  private handleOpen(): void {
    if (this.opened || this.localClosed || this.terminalError) return;
    this.opened = true;
    this.clearOpenTimer();
    const resolve = this.openResolve;
    this.openResolve = undefined;
    this.openReject = undefined;
    resolve?.();
    this.emit('open', undefined);
  }

  private handleMessage(data: unknown): void {
    if (this.localClosed || this.terminalError) return;

    const bytes = asBytes(data);
    if (!bytes) {
      const error = new RustDeskError(
        'protocol-error',
        'Expected a binary WebSocket frame; RustDesk never sends text frames',
      );
      this.fail(error);
      this.emit('error', error);
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(bytes);
    } else {
      this.queue.push(bytes);
    }
    this.emit('message', bytes);
  }

  private handleError(event: unknown): void {
    if (this.localClosed) return;
    const error = this.opened
      ? new RustDeskError('connection-lost', 'WebSocket error', { cause: event })
      : new RustDeskError('server-unreachable', 'WebSocket failed to connect', { cause: event });
    this.fail(error);
    this.emit('error', error);
  }

  private handleClose(event: WebSocketCloseInfo): void {
    const error = this.opened
      ? event.code === 1009
        ? new RustDeskError(
            'message-too-large',
            'The server or reverse proxy rejected an oversized message (close code 1009)',
          )
        : new RustDeskError(
            'connection-lost',
            `WebSocket closed${event.code ? ` (code ${event.code})` : ''}`,
          )
      : new RustDeskError('server-unreachable', 'WebSocket closed before it opened');

    this.fail(error);
    this.emit('close', {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean ?? false,
      local: false,
    });
  }

  private settleOpen(error: RustDeskError): void {
    this.clearOpenTimer();
    const reject = this.openReject;
    this.openResolve = undefined;
    this.openReject = undefined;
    reject?.(error);
  }

  private clearOpenTimer(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = undefined;
    }
  }

  private rejectWaiters(error: RustDeskError): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private detachSocket(): void {
    this.socket.onopen = null;
    this.socket.onmessage = null;
    this.socket.onerror = null;
    this.socket.onclose = null;
  }

  private emit<K extends EventName>(event: K, payload: WebSockEventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set?.size) return;
    for (const handler of [...set]) handler(payload);
  }
}
