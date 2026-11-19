import { afterEach, describe, expect, it, vi } from 'vitest';
import { RustDeskError } from '../src/session/errors';
import type { PermissionEvent } from '../src/session/permissions';
import type { PeerInfo } from '../src/session/peer-info';
import {
  RustDeskSession,
  type RustDeskSessionDeps,
} from '../src/session/RustDeskSession';
import type { RustDeskStatusEvent } from '../src/session/state';
import type { RustDeskSessionConfig } from '../src/session/options';
import {
  KeyboardMode,
  Message,
  OptionMessage_BoolOption,
  PermissionInfo_Permission,
  type DeepPartial,
  type Message as MessageType,
} from '../src/protocol/message';
import type {
  RelayConnection,
  RendezvousConnectOptions,
} from '../src/protocol/connection';
import type { RemoteClipboardEvent } from '../src/input/clipboard';
import type { VideoSink } from '../src/media/video-pipeline';
import { waitFor } from './mocks/rustdesk-mock';

// P4-1 unit coverage: every session status transition, password retry,
// abort/error paths, pending/heartbeat routing, permission/clipboard gating,
// display validation and the video sink/decoder lifecycle.

class FakeConnection implements RelayConnection {
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

const DISPLAYS = [
  { x: 0, y: 0, width: 1920, height: 1080, name: 'DP-1', online: true },
  { x: 1920, y: 0, width: 1280, height: 720, name: 'DP-2', online: true },
];

function peerInfoPayload(): DeepPartial<MessageType> {
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

const sessions: RustDeskSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.dispose();
  }
});

interface Harness {
  session: RustDeskSession;
  connection: FakeConnection;
  statuses: RustDeskStatusEvent[];
  errors: RustDeskError[];
  permissions: PermissionEvent[];
  clipboards: RemoteClipboardEvent[];
  peerInfos: PeerInfo[];
  downgrades: RustDeskError[];
}

function makeHarness(options: {
  config?: Partial<RustDeskSessionConfig>;
  deps?: Partial<RustDeskSessionDeps>;
  connection?: FakeConnection;
} = {}): Harness {
  const connection = options.connection ?? new FakeConnection();
  const statuses: RustDeskStatusEvent[] = [];
  const errors: RustDeskError[] = [];
  const permissions: PermissionEvent[] = [];
  const clipboards: RemoteClipboardEvent[] = [];
  const peerInfos: PeerInfo[] = [];
  const downgrades: RustDeskError[] = [];
  const session = new RustDeskSession(
    {
      server: '127.0.0.1:21116',
      id: '123456789',
      password: 'secret',
      ...options.config,
    },
    {
      connectRelay: async (connectOptions: RendezvousConnectOptions) => {
        connectOptions.onSecuring?.();
        return connection;
      },
      secure: false,
      autoCopyClipboard: false,
      heartbeatIntervalMs: 50,
      ...options.deps,
    },
  );
  session.on('status', (event) => statuses.push(event));
  session.on('error', (error) => errors.push(error));
  session.on('permission', (event) => permissions.push(event));
  session.on('clipboard', (event) => clipboards.push(event));
  session.on('peerInfo', (info) => peerInfos.push(info));
  session.on('securityDowngraded', (error) => downgrades.push(error));
  sessions.push(session);
  return {
    session,
    connection,
    statuses,
    errors,
    permissions,
    clipboards,
    peerInfos,
    downgrades,
  };
}

async function connect(harness: Harness): Promise<PeerInfo> {
  const promise = harness.session.connect();
  harness.connection.push({ hash: { salt: 'salt', challenge: 'challenge' } });
  harness.connection.push(peerInfoPayload());
  return promise;
}

describe('RustDeskSession', () => {
  it('connects through connecting/securing/authenticating/connected', async () => {
    const harness = makeHarness();
    const info = await connect(harness);

    expect(info.username).toBe('alice');
    expect(info.displays).toHaveLength(2);
    expect(harness.session.status).toBe('connected');
    expect(harness.session.peerInfo).toEqual(info);
    expect(harness.session.currentDisplay).toBe(0);
    expect(harness.statuses.map((event) => event.status)).toEqual([
      'connecting',
      'securing',
      'authenticating',
      'authenticating',
      'connected',
    ]);
    expect(harness.errors).toEqual([]);
    await expect(harness.session.connect()).rejects.toMatchObject({
      code: 'invalid-state',
    });
  });

  it('replays login-time video/clipboard and applies login permissions', async () => {
    const harness = makeHarness();
    const promise = harness.session.connect();
    harness.connection.push({ hash: { salt: 'salt', challenge: 'challenge' } });
    harness.connection.push({
      video_frame: {
        vp9s: { frames: [{ key: true, data: new Uint8Array([1, 2]) }] },
      },
    });
    harness.connection.push({
      clipboard: {
        format: 0,
        compress: false,
        content: new TextEncoder().encode('early text'),
      },
    });
    harness.connection.push({
      misc: {
        permission_info: {
          permission: PermissionInfo_Permission.Keyboard,
          enabled: false,
        },
      },
    });
    harness.connection.push(peerInfoPayload());
    await promise;

    expect(harness.session.permissions.policy.mouse).toBe(false);
    expect(harness.errors).toEqual([]);
    await waitFor(() => harness.clipboards.length === 1, 1000);
    expect(harness.clipboards[0]?.text).toBe('early text');
    // LoginFlow acked the early frame; the pending replay must not ack again.
    expect(
      harness.connection.sent.filter(
        (payload) => payload.misc?.video_received === true,
      ),
    ).toHaveLength(1);
  });

  it('waits for approval after 3s and then connects', async () => {
    const harness = makeHarness({
      deps: { approvalAfterMs: 10 },
    });
    const promise = harness.session.connect();
    harness.connection.push({ hash: { salt: 'salt', challenge: 'challenge' } });
    await waitFor(
      () => harness.statuses.some((event) => event.status === 'awaiting-approval'),
      1000,
    );
    harness.connection.push(peerInfoPayload());
    await promise;
    expect(harness.statuses.map((event) => event.status)).toContain(
      'awaiting-approval',
    );
    expect(harness.session.status).toBe('connected');
  });

  it('requests a password, retries on the same flow and rejects other states', async () => {
    const harness = makeHarness({ config: { password: undefined } });
    await expect(harness.session.login('early')).rejects.toMatchObject({
      code: 'invalid-state',
    });

    const connecting = harness.session.connect();
    harness.connection.push({ hash: { salt: 'salt', challenge: 'challenge' } });
    await waitFor(
      () =>
        harness.statuses.some(
          (event) =>
            event.status === 'password-required' && event.retry === false,
        ),
      1000,
    );

    const retry = harness.session.login('bad');
    harness.connection.push({ login_response: { error: 'Wrong Password' } });
    await waitFor(
      () =>
        harness.statuses.some(
          (event) =>
            event.status === 'password-required' && event.retry === true,
        ),
      1000,
    );

    const second = harness.session.login('good');
    harness.connection.push(peerInfoPayload());
    const info = await second;
    await connecting;
    expect(info.username).toBe('alice');
    expect(retry).toBeDefined();
    expect(harness.session.status).toBe('connected');
    await expect(harness.session.login('again')).rejects.toMatchObject({
      code: 'invalid-state',
    });
  });

  it('aborts a pending connect as disconnected without an error event', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    const promise = harness.session.connect(controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(harness.session.status).toBe('disconnected');
    expect(harness.errors).toEqual([]);
  });

  it('maps a connect failure to the error status and error event', async () => {
    const failure = new RustDeskError('peer-offline', 'Offline');
    const harness = makeHarness({
      deps: {
        connectRelay: async () => {
          throw failure;
        },
      },
    });
    await expect(harness.session.connect()).rejects.toBe(failure);
    expect(harness.session.status).toBe('error');
    expect(harness.errors).toEqual([failure]);
    expect(harness.statuses.map((event) => event.status)).toEqual([
      'connecting',
      'error',
    ]);
  });

  it('disconnects cleanly and dispose returns to idle', async () => {
    const harness = makeHarness();
    await connect(harness);

    harness.session.disconnect();
    expect(harness.session.status).toBe('disconnected');
    expect(harness.connection.closed).toBe(true);

    await harness.session.dispose();
    expect(harness.session.status).toBe('idle');
    await expect(harness.session.connect()).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('disposes a pending connect and is idempotent', async () => {
    const harness = makeHarness();
    const promise = harness.session.connect();
    await harness.session.dispose();
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(harness.session.status).toBe('idle');
    expect(harness.connection.closed).toBe(true);

    await harness.session.dispose();
    await expect(harness.session.connect()).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('reconnects after disconnect without stale state', async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    let calls = 0;
    const harness = makeHarness({
      connection: first,
      deps: {
        connectRelay: async (options: RendezvousConnectOptions) => {
          options.onSecuring?.();
          calls += 1;
          return calls === 1 ? first : second;
        },
      },
    });
    await connect(harness);
    harness.connection.push({
      clipboard: {
        format: 0,
        compress: false,
        content: new TextEncoder().encode('same'),
      },
    });
    await waitFor(() => harness.clipboards.length === 1, 1000);
    expect(harness.session.sendText('same')).toBe(false);

    harness.session.disconnect();
    await waitFor(() => first.closed, 1000);
    const reconnecting = harness.session.connect();
    second.push({ hash: { salt: 'salt2', challenge: 'challenge2' } });
    second.push(peerInfoPayload());
    await reconnecting;

    expect(harness.session.status).toBe('connected');
    expect(harness.session.sendText('same')).toBe(true);
    expect(
      harness.statuses.map((event) => event.status),
    ).toEqual(
      expect.arrayContaining(['disconnected', 'connecting', 'connected']),
    );
  });

  it('binds viewer inputs, syncs origins/platform and applies read-only', async () => {
    const harness = makeHarness();
    await connect(harness);
    const mouse = { setEnabled: vi.fn(), setOrigin: vi.fn() };
    const keyboard = { setEnabled: vi.fn(), setPlatform: vi.fn() };
    const touch = { setEnabled: vi.fn(), setOrigin: vi.fn() };
    harness.session.bindInputs({ mouse, keyboard, touch });
    expect(mouse.setEnabled).toHaveBeenLastCalledWith(true);
    expect(mouse.setOrigin).toHaveBeenLastCalledWith({ x: 0, y: 0 });
    expect(touch.setOrigin).toHaveBeenLastCalledWith({ x: 0, y: 0 });
    expect(keyboard.setPlatform).toHaveBeenLastCalledWith('Linux');

    harness.session.switchDisplay(1);
    expect(mouse.setOrigin).toHaveBeenLastCalledWith({ x: 1920, y: 0 });

    harness.session.setReadOnly(true);
    expect(mouse.setEnabled).toHaveBeenLastCalledWith(false);
    expect(harness.session.sendText('blocked')).toBe(false);
  });

  it('turns a stale read timeout into an error state', async () => {
    const harness = makeHarness();
    await connect(harness);
    harness.connection.fail(
      new RustDeskError('timeout', 'No WebSocket message within 30000 ms'),
    );
    await waitFor(() => harness.session.status === 'error', 1000);
    expect(harness.errors.at(-1)?.code).toBe('timeout');
  });

  it('routes TestDelay, video acks, permissions and clipboard text', async () => {
    const harness = makeHarness();
    await connect(harness);

    harness.connection.push({
      test_delay: { time: 123, from_client: false },
    });
    await waitFor(
      () =>
        harness.connection.sent.some(
          (payload) =>
            payload.test_delay?.time === 123 &&
            payload.test_delay.from_client === false,
        ),
      1000,
    );

    harness.connection.push({
      video_frame: {
        vp9s: { frames: [{ key: true, data: new Uint8Array([1, 2]) }] },
      },
    });
    await waitFor(
      () =>
        harness.connection.sent.some(
          (payload) => payload.misc?.video_received === true,
        ),
      1000,
    );

    harness.connection.push({
      misc: {
        permission_info: {
          permission: PermissionInfo_Permission.Keyboard,
          enabled: false,
        },
      },
    });
    await waitFor(() => harness.permissions.length === 1, 1000);
    expect(harness.permissions[0]?.policy.mouse).toBe(false);
    expect(harness.errors.map((error) => error.code)).toEqual([
      'no-permission',
    ]);

    harness.connection.push({
      clipboard: {
        format: 0,
        compress: false,
        content: new TextEncoder().encode('remote text'),
      },
    });
    await waitFor(() => harness.clipboards.length === 1, 1000);
    expect(harness.clipboards[0]).toEqual({
      text: 'remote text',
      copied: false,
    });

    expect(harness.session.sendText('blocked')).toBe(false);
    harness.connection.push({
      misc: {
        permission_info: {
          permission: PermissionInfo_Permission.Keyboard,
          enabled: true,
        },
      },
    });
    await waitFor(() => harness.permissions.length === 2, 1000);
    expect(harness.session.sendText('local text')).toBe(true);
    expect(
      harness.connection.sent.some(
        (payload) => payload.clipboard?.content?.length === 10,
      ),
    ).toBe(true);
  });

  it('gates raw sendMouse/sendKey on the permission policy', async () => {
    const harness = makeHarness();
    await connect(harness);
    const mouse = Message.fromPartial({
      mouse_event: { mask: 9, x: 12, y: 34, modifiers: [] },
    }).mouse_event!;
    const key = Message.fromPartial({
      key_event: {
        chr: 65,
        mode: KeyboardMode.Map,
        down: true,
        press: false,
        modifiers: [],
      },
    }).key_event!;

    harness.session.sendMouse(mouse);
    harness.session.sendKey(key);
    expect(
      harness.connection.sent.some(
        (payload) => payload.mouse_event !== undefined,
      ),
    ).toBe(true);
    expect(
      harness.connection.sent.some(
        (payload) => payload.key_event !== undefined,
      ),
    ).toBe(true);

    harness.connection.push({
      misc: {
        permission_info: {
          permission: PermissionInfo_Permission.Keyboard,
          enabled: false,
        },
      },
    });
    await waitFor(
      () => !harness.session.permissions.policy.mouse,
      1000,
    );
    const sent = harness.connection.sent.length;
    harness.session.sendMouse(mouse);
    harness.session.sendKey(key);
    expect(harness.connection.sent).toHaveLength(sent);
  });

  it('sends a post-login heartbeat and measures TestDelay latency', async () => {
    const harness = makeHarness({
      deps: { heartbeatIntervalMs: 15 },
    });
    await connect(harness);
    await waitFor(
      () =>
        harness.connection.sent.some(
          (payload) => payload.test_delay?.from_client === true,
        ),
      1000,
    );
    const sentAt = Date.now() - 20;
    harness.connection.push({
      test_delay: { time: sentAt, from_client: true },
    });
    await waitFor(() => harness.session.latencyMs >= 10, 1000);
    expect(harness.session.latencyMs).toBeLessThan(1000);
  });

  it('reports peer close and non-VP9 frames', async () => {
    const harness = makeHarness();
    await connect(harness);

    harness.connection.push({ video_frame: { display: 0 } });
    await waitFor(
      () => harness.errors.some((error) => error.code === 'unsupported-codec'),
      1000,
    );

    harness.connection.push({ misc: { close_reason: 'bye' } });
    await waitFor(
      () => harness.session.status === 'disconnected',
      1000,
    );
    expect(harness.statuses.at(-1)).toMatchObject({
      status: 'disconnected',
      detail: 'bye',
    });
  });

  it('validates display switches and emits peerInfo updates', async () => {
    const harness = makeHarness();
    await connect(harness);
    expect(harness.peerInfos).toHaveLength(1);

    harness.session.switchDisplay(1);
    expect(harness.session.currentDisplay).toBe(1);
    expect(harness.peerInfos.at(-1)?.currentDisplay).toBe(1);
    expect(
      harness.connection.sent.some(
        (payload) => payload.misc?.switch_display?.display === 1,
      ),
    ).toBe(true);

    const sentCount = harness.connection.sent.length;
    harness.session.switchDisplay(9);
    expect(harness.connection.sent).toHaveLength(sentCount);

    harness.connection.push({
      misc: { switch_display: { display: 0 } },
    });
    await waitFor(
      () => harness.session.currentDisplay === 0,
      1000,
    );
    expect(harness.peerInfos.at(-1)?.currentDisplay).toBe(0);

    harness.connection.push({
      peer_info: { displays: [DISPLAYS[0]!] },
    });
    await waitFor(
      () => harness.session.peerInfo?.displays.length === 1,
      1000,
    );
    expect(harness.session.currentDisplay).toBe(0);
  });

  it('asks the host to disable clipboard for read-only or disable-clipboard', async () => {
    for (const config of [{ readOnly: true }, { disableClipboard: true }]) {
      const harness = makeHarness({ config });
      await connect(harness);
      const request = harness.connection.sent.find(
        (payload) => payload.login_request !== undefined,
      )?.login_request;
      expect(request?.option?.disable_clipboard).toBe(
        OptionMessage_BoolOption.Yes,
      );
    }
  });

  it('emits securityDowngraded when the handshake falls back', async () => {
    const downgrade = new RustDeskError(
      'peer-signature-invalid',
      'Peer identity could not be verified',
    );
    const harness = makeHarness({
      connection: new FakeConnection(false, downgrade),
    });
    await connect(harness);
    expect(harness.downgrades).toEqual([downgrade]);
    expect(harness.session.status).toBe('connected');
  });

  it('drives the video sink and disposes the decoder after the pipeline', async () => {
    const frame = { width: 64, height: 64 };
    const decoder = {
      decode: vi.fn(async () => frame),
      recycle: vi.fn(),
      rebuild: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const draw = vi.fn((_frame: unknown, release: () => void) => release());
    const sink: VideoSink = { draw };
    const createDecoder = vi.fn(async () => decoder);
    const harness = makeHarness({
      config: { assetBaseUrl: '/assets/' },
      deps: { createDecoder },
    });
    await connect(harness);
    harness.session.setVideoSink(sink);
    await waitFor(() => createDecoder.mock.calls.length === 1, 1000);
    expect(createDecoder).toHaveBeenCalledWith({
      assetBaseUrl: '/assets/',
    });

    harness.connection.push({
      video_frame: {
        vp9s: { frames: [{ key: true, data: new Uint8Array([1, 2]) }] },
      },
    });
    await waitFor(() => draw.mock.calls.length === 1, 2000);
    expect(decoder.decode).toHaveBeenCalled();

    await harness.session.dispose();
    expect(decoder.dispose).toHaveBeenCalledTimes(1);
  });

  it('returns working unsubscribe functions and swallows listener errors', async () => {
    const harness = makeHarness();
    const seen: string[] = [];
    const off = harness.session.on('status', (event) => {
      seen.push(event.status);
    });
    off();
    harness.session.on('status', () => {
      throw new Error('host listener boom');
    });
    await connect(harness);
    expect(seen).toEqual([]);
    expect(harness.session.status).toBe('connected');
  });
});
