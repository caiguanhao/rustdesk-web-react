import type { RelayConnection } from '../../src/protocol/connection';
import {
  Message,
  type DeepPartial,
  type Message as MessageType,
} from '../../src/protocol/message';
import { RustDeskError } from '../../src/session/errors';

/**
 * In-memory RelayConnection for Node/jsdom tests. Messages pushed by the test
 * flow to LoginFlow/session readers; `close()` rejects pending reads so
 * dispose/abort paths settle deterministically.
 */
export class FakeConnection implements RelayConnection {
  relayResponse = {} as RelayConnection['relayResponse'];
  rendezvousUrl = 'ws://test/id';
  relayUrl = 'ws://test/relay';
  secure: boolean;
  downgrade?: RustDeskError;
  readonly sent: DeepPartial<MessageType>[] = [];
  closed = false;
  private queue: MessageType[] = [];
  private failure?: unknown;
  private waiters: {
    resolve: (message: MessageType) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }[] = [];

  constructor(secure = true, downgrade?: RustDeskError) {
    this.secure = secure;
    this.downgrade = downgrade;
  }

  sendMessage(payload: DeepPartial<MessageType>): void {
    if (this.closed) {
      throw new RustDeskError('aborted', 'WebSocket closed locally');
    }
    this.sent.push(payload);
  }

  nextMessage(_timeoutMs?: number, signal?: AbortSignal): Promise<MessageType> {
    if (signal?.aborted) {
      return Promise.reject(new RustDeskError('aborted', 'aborted'));
    }
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) {
      return Promise.reject(new RustDeskError('aborted', 'closed'));
    }
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject, signal };
      waiter.onAbort = () => {
        this.remove(waiter);
        reject(new RustDeskError('aborted', 'aborted'));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  push(payload: DeepPartial<MessageType>): void {
    const message = Message.fromPartial(payload);
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.queue.push(message);
      return;
    }
    this.settle(waiter);
    waiter.resolve(message);
  }

  fail(error: unknown): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      this.settle(waiter);
      waiter.reject(error);
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      this.settle(waiter);
      waiter.reject(new RustDeskError('aborted', 'closed'));
    }
  }

  private remove(waiter: (typeof this.waiters)[number]): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private settle(waiter: (typeof this.waiters)[number]): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }
}

export const FAKE_HASH = {
  salt: 'salt',
  challenge: 'challenge',
};

export const DISPLAYS = [
  { x: 0, y: 0, width: 1920, height: 1080, name: 'DP-1', online: true },
  { x: 1920, y: 0, width: 1280, height: 720, name: 'DP-2', online: true },
];

export function peerInfoPayload(): DeepPartial<MessageType> {
  return {
    login_response: {
      peer_info: {
        username: 'alice',
        hostname: 'host',
        platform: 'Linux',
        displays: DISPLAYS,
        current_display: 0,
        sas_enabled: false,
        version: '1.5.3',
      },
    },
  };
}

/** Feed the Hash and peer_info a LoginFlow needs to reach `connected`. */
export function completeFakeLogin(
  connection: FakeConnection,
  info: DeepPartial<MessageType> = peerInfoPayload(),
): void {
  connection.push({ hash: FAKE_HASH });
  connection.push(info);
}
