import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket as WsClient, WebSocketServer, type RawData } from 'ws';
import { challengeResponse } from '../src/crypto/password';
import {
  LoginFlow,
  WEB_CLIENT_VERSION,
  type LoginFlowOptions,
} from '../src/protocol/login';
import { PASSWORD_SALT_MISMATCH_DETAIL } from '../src/session/credentials';
import { RustDeskError } from '../src/session/errors';
import type { PermissionChange } from '../src/session/permissions';
import { h1Base64 } from './mocks/credentials';
import * as message from '../src/protocol/message';
import type { DeepPartial } from '../src/protocol/message';
import { WebSock, type WebSocketLike } from '../src/protocol/websock';
import type { RustDeskStatusEvent } from '../src/session/state';

// P1-7 acceptance: Hash → minimal LoginRequest → peer_info, wrong-password
// retry on the same Hash, approval/heartbeat/permission handling, and typed
// login error strings. A mock peer server drives every case.

const PEER_ID = '123456789';
const SALT = 'test-salt';
const CHALLENGE = 'test-challenge';

const createSocket = (url: string): WebSocketLike =>
  new WsClient(url) as unknown as WebSocketLike;

function rawToBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

const encodeMessage = (partial: DeepPartial<message.Message>): Uint8Array =>
  message.Message.encode(message.Message.fromPartial(partial)).finish();

const decodeMessage = (bytes: Uint8Array): message.Message => message.Message.decode(bytes);

interface Waiter {
  predicate: (msg: message.Message) => boolean;
  resolve: (msg: message.Message) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface StatusWaiter {
  predicate: (event: RustDeskStatusEvent) => boolean;
  resolve: (event: RustDeskStatusEvent) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function trackStatuses(): {
  events: RustDeskStatusEvent[];
  onStatus: (event: RustDeskStatusEvent) => void;
  waitFor: (
    predicate: (event: RustDeskStatusEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<RustDeskStatusEvent>;
} {
  const events: RustDeskStatusEvent[] = [];
  const waiters: StatusWaiter[] = [];
  const onStatus = (event: RustDeskStatusEvent): void => {
    events.push(event);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (!waiter.predicate(event)) continue;
      waiters.splice(index, 1);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  };
  const waitFor = (
    predicate: (event: RustDeskStatusEvent) => boolean,
    timeoutMs = 1000,
  ): Promise<RustDeskStatusEvent> => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: StatusWaiter = {
        predicate,
        resolve: (event) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve(event);
        },
      };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('status timeout'));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  return { events, onStatus, waitFor };
}

class Harness {
  readonly sock: WebSock;
  private readonly peer: WsClient;
  private readonly wss: WebSocketServer;
  private readonly queue: message.Message[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly cleanups: (() => void)[] = [];

  constructor(peer: WsClient, wss: WebSocketServer, sock: WebSock) {
    this.peer = peer;
    this.wss = wss;
    this.sock = sock;
    peer.on('message', (data) => this.onFrame(rawToBytes(data)));
  }

  makeFlow(options: LoginFlowOptions): LoginFlow {
    const flow = new LoginFlow(this.sock, options);
    this.cleanups.push(() => flow.dispose());
    return flow;
  }

  send(partial: DeepPartial<message.Message>): void {
    this.peer.send(encodeMessage(partial));
  }

  next(
    predicate: (msg: message.Message) => boolean = () => true,
    timeoutMs = 1000,
  ): Promise<message.Message> {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve: (msg) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve(msg);
        },
      };
      waiter.timer = setTimeout(() => {
        const waiterIndex = this.waiters.indexOf(waiter);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new Error('peer message timeout'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.sock.close();
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private onFrame(bytes: Uint8Array): void {
    const msg = decodeMessage(bytes);
    const index = this.waiters.findIndex((waiter) => waiter.predicate(msg));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter?.resolve(msg);
      return;
    }
    this.queue.push(msg);
  }
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const connected = once(wss, 'connection');
  const sock = new WebSock(`ws://127.0.0.1:${address.port}`, { createSocket });
  await sock.open(1000);
  const [peer] = (await connected) as [WsClient];
  const harness = new Harness(peer, wss, sock);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

function options(overrides: Partial<LoginFlowOptions> = {}): LoginFlowOptions {
  return {
    peerId: PEER_ID,
    loginTimeoutMs: 1000,
    approvalAfterMs: 30,
    heartbeatIntervalMs: 60_000,
    ...overrides,
  };
}

const PEER_INFO: DeepPartial<message.PeerInfo> = {
  username: 'alice',
  hostname: 'desktop',
  platform: 'Linux',
  displays: [{ x: 0, y: 0, width: 1920, height: 1080, name: 'DP-1', online: true }],
  current_display: 0,
  sas_enabled: false,
  version: '1.5.3',
  conn_id: 42,
  features: { privacy_mode: false },
};

const hash = { salt: SALT, challenge: CHALLENGE };

const H1_SECRET = h1Base64('secret', SALT);

function expectInvalidConfig(run: () => unknown): void {
  try {
    run();
    expect.unreachable('expected invalid-config');
  } catch (error) {
    expect(error).toBeInstanceOf(RustDeskError);
    expect((error as RustDeskError).code).toBe('invalid-config');
  }
}

async function expectNoLoginRequest(harness: Harness): Promise<void> {
  await expect(
    harness.next((msg) => Boolean(msg.login_request), 100),
  ).rejects.toThrow('peer message timeout');
}

describe('login flow', () => {
  it('sends the minimal LoginRequest, echoes TestDelay, reports permission and peer_info', async () => {
    await withHarness(async (harness) => {
      const tracker = trackStatuses();
      const permissions: PermissionChange[] = [];
      const flow = harness.makeFlow(
        options({
          password: 'secret',
          onStatus: tracker.onStatus,
          onPermission: (change) => permissions.push(change),
        }),
      );

      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      harness.send({ test_delay: { time: 123, from_client: false } });
      harness.send({ hash });
      const infoPromise = flow.start();

      const request = (await requestPromise).login_request!;
      expect(request.username).toBe(PEER_ID);
      expect(request.my_id).toBe('web');
      expect(request.my_name).toBe('web');
      expect(Array.from(request.password)).toEqual(
        Array.from(challengeResponse('secret', SALT, CHALLENGE)),
      );
      expect(request.video_ack_required).toBe(true);
      expect(request.version).toBe('');
      expect(request.my_platform).toBe('');
      expect(request.option?.disable_audio).toBe(message.OptionMessage_BoolOption.Yes);
      expect(request.option?.show_remote_cursor).toBe(message.OptionMessage_BoolOption.No);
      expect(request.option?.image_quality).toBe(message.ImageQuality.Balanced);

      const echo = await harness.next((msg) => Boolean(msg.test_delay));
      expect(echo.test_delay).toMatchObject({ time: 123, from_client: false });

      harness.send({
        misc: {
          permission_info: {
            permission: message.PermissionInfo_Permission.Keyboard,
            enabled: false,
          },
        },
      });
      harness.send({ login_response: { peer_info: PEER_INFO } });

      const info = await infoPromise;
      expect(info).toMatchObject({
        username: 'alice',
        hostname: 'desktop',
        platform: 'Linux',
        currentDisplay: 0,
        sasEnabled: false,
        version: '1.5.3',
        connectionId: 42,
        privacyMode: false,
      });
      expect(info.displays[0]).toMatchObject({ width: 1920, height: 1080 });
      expect(permissions).toEqual([{ permission: 'keyboard', enabled: false }]);
      expect(tracker.events.map((event) => event.status)).toEqual([
        'authenticating',
        'authenticating',
        'connected',
      ]);
    });
  });

  it('sends version/my_platform only when advertised and honours imageQuality', async () => {
    await withHarness(async (harness) => {
      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      harness.send({ hash });
      const flow = harness.makeFlow(
        options({
          password: 'secret',
          advertiseWebClientVersion: true,
          imageQuality: 'best',
        }),
      );
      const infoPromise = flow.start();
      const request = (await requestPromise).login_request!;
      expect(request.version).toBe(WEB_CLIENT_VERSION);
      expect(request.my_platform).toBe('web');
      expect(request.option?.image_quality).toBe(message.ImageQuality.Best);

      harness.send({ login_response: { peer_info: PEER_INFO } });
      await infoPromise;
    });
  });

  it('asks for a password when none was supplied, then logs in', async () => {
    await withHarness(async (harness) => {
      const tracker = trackStatuses();
      harness.send({ hash });
      const flow = harness.makeFlow(options({ onStatus: tracker.onStatus }));
      const infoPromise = flow.start();

      const prompt = await tracker.waitFor((event) => event.status === 'password-required');
      expect(prompt).toMatchObject({ status: 'password-required', retry: false });

      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      flow.login('secret');
      const request = (await requestPromise).login_request!;
      expect(Array.from(request.password)).toEqual(
        Array.from(challengeResponse('secret', SALT, CHALLENGE)),
      );

      harness.send({ login_response: { peer_info: PEER_INFO } });
      await expect(infoPromise).resolves.toMatchObject({ username: 'alice' });
    });
  });

  it('retries a wrong password with the same Hash', async () => {
    await withHarness(async (harness) => {
      const tracker = trackStatuses();
      harness.send({ hash });
      const flow = harness.makeFlow(
        options({ password: 'wrong', onStatus: tracker.onStatus }),
      );

      const firstRequest = harness.next((msg) => Boolean(msg.login_request));
      const infoPromise = flow.start();
      const first = (await firstRequest).login_request!;
      expect(Array.from(first.password)).not.toEqual(
        Array.from(challengeResponse('correct', SALT, CHALLENGE)),
      );

      harness.send({ login_response: { error: 'Wrong Password' } });
      const retry = await tracker.waitFor((event) => event.status === 'password-required');
      expect(retry).toMatchObject({
        status: 'password-required',
        retry: true,
        detail: 'Wrong Password',
      });

      const secondRequest = harness.next((msg) => Boolean(msg.login_request));
      flow.login('correct');
      const second = (await secondRequest).login_request!;
      expect(Array.from(second.password)).toEqual(
        Array.from(challengeResponse('correct', SALT, CHALLENGE)),
      );
      expect(second.username).toBe(PEER_ID);

      harness.send({ login_response: { peer_info: PEER_INFO } });
      await expect(infoPromise).resolves.toMatchObject({ username: 'alice' });
    });
  });

  it('logs in with a pre-hashed h1 without a plaintext password', async () => {
    await withHarness(async (harness) => {
      const tracker = trackStatuses();
      harness.send({ hash });
      const flow = harness.makeFlow(
        options({
          password: { hash: H1_SECRET, salt: SALT },
          onStatus: tracker.onStatus,
        }),
      );
      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      const infoPromise = flow.start();
      const request = (await requestPromise).login_request!;
      expect(Array.from(request.password)).toEqual(
        Array.from(challengeResponse('secret', SALT, CHALLENGE)),
      );
      expect(
        tracker.events.some((event) => event.status === 'password-required'),
      ).toBe(false);

      harness.send({ login_response: { peer_info: PEER_INFO } });
      await expect(infoPromise).resolves.toMatchObject({ username: 'alice' });
    });
  });

  it('accepts a hash object without salt', async () => {
    await withHarness(async (harness) => {
      harness.send({ hash });
      const flow = harness.makeFlow(options({ password: { hash: H1_SECRET } }));
      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      const infoPromise = flow.start();
      const request = (await requestPromise).login_request!;
      expect(Array.from(request.password)).toEqual(
        Array.from(challengeResponse('secret', SALT, CHALLENGE)),
      );
      harness.send({ login_response: { peer_info: PEER_INFO } });
      await infoPromise;
    });
  });

  it('asks for a password when the configured hash salt does not match', async () => {
    await withHarness(async (harness) => {
      const tracker = trackStatuses();
      harness.send({ hash });
      const flow = harness.makeFlow(
        options({
          password: { hash: H1_SECRET, salt: 'other-salt' },
          onStatus: tracker.onStatus,
        }),
      );
      const infoPromise = flow.start();

      const prompt = await tracker.waitFor(
        (event) => event.status === 'password-required',
      );
      expect(prompt).toMatchObject({
        status: 'password-required',
        retry: false,
        detail: PASSWORD_SALT_MISMATCH_DETAIL,
      });
      await expectNoLoginRequest(harness);

      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      flow.login({ hash: H1_SECRET, salt: SALT });
      const request = (await requestPromise).login_request!;
      expect(Array.from(request.password)).toEqual(
        Array.from(challengeResponse('secret', SALT, CHALLENGE)),
      );

      harness.send({ login_response: { peer_info: PEER_INFO } });
      await infoPromise;
    });
  });

  it('rejects a retry hash with a mismatched salt without sending it', async () => {
    await withHarness(async (harness) => {
      const tracker = trackStatuses();
      harness.send({ hash });
      const flow = harness.makeFlow(options({ onStatus: tracker.onStatus }));
      const infoPromise = flow.start();
      await tracker.waitFor((event) => event.status === 'password-required');

      expectInvalidConfig(() => flow.login({ hash: H1_SECRET, salt: 'other-salt' }));
      await expectNoLoginRequest(harness);

      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      flow.login({ hash: H1_SECRET, salt: SALT });
      const request = (await requestPromise).login_request!;
      expect(Array.from(request.password)).toEqual(
        Array.from(challengeResponse('secret', SALT, CHALLENGE)),
      );
      harness.send({ login_response: { peer_info: PEER_INFO } });
      await infoPromise;
    });
  });

  it('rejects a malformed hash and remains usable', async () => {
    await withHarness(async (harness) => {
      const tracker = trackStatuses();
      harness.send({ hash });
      const flow = harness.makeFlow(options({ onStatus: tracker.onStatus }));
      const infoPromise = flow.start();
      await tracker.waitFor((event) => event.status === 'password-required');

      expectInvalidConfig(() => flow.login({ hash: 'not-base64' }));
      await expectNoLoginRequest(harness);

      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      flow.login('secret');
      const request = (await requestPromise).login_request!;
      expect(Array.from(request.password)).toEqual(
        Array.from(challengeResponse('secret', SALT, CHALLENGE)),
      );
      harness.send({ login_response: { peer_info: PEER_INFO } });
      await infoPromise;
    });
  });

  it('treats No Password Access as awaiting approval and keeps waiting', async () => {
    await withHarness(async (harness) => {
      const tracker = trackStatuses();
      harness.send({ hash });
      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      const flow = harness.makeFlow(
        options({ password: 'secret', onStatus: tracker.onStatus }),
      );
      const infoPromise = flow.start();
      await requestPromise;

      harness.send({ login_response: { error: 'No Password Access' } });
      await tracker.waitFor((event) => event.status === 'awaiting-approval');

      harness.send({ login_response: { peer_info: PEER_INFO } });
      await expect(infoPromise).resolves.toMatchObject({ username: 'alice' });
    });
  });

  it.each([
    ['Too many wrong attempts', 'too-many-attempts'],
    ['Please try 1 minute later', 'try-later'],
    ['2FA Required', 'two-factor-required'],
    ['Wrong 2FA Code', 'two-factor-required'],
    ['Your ip is blocked by the peer', 'blocked'],
    ['No permission of viewing camera', 'no-permission'],
    ['Offline', 'peer-offline'],
    ['Some other failure', 'peer-error'],
  ])('maps login error %s to %s', async (error, code) => {
    await withHarness(async (harness) => {
      harness.send({ hash });
      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      const flow = harness.makeFlow(options({ password: 'secret' }));
      const infoPromise = flow.start();
      await requestPromise;

      const expectation = expect(infoPromise).rejects.toMatchObject({ code });
      harness.send({ login_response: { error } });
      await expectation;
    });
  });

  it('times out with login-timeout', async () => {
    await withHarness(async (harness) => {
      harness.send({ hash });
      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      const flow = harness.makeFlow(options({ password: 'secret', loginTimeoutMs: 40 }));
      const infoPromise = flow.start();
      await requestPromise;
      await expect(infoPromise).rejects.toMatchObject({ code: 'login-timeout' });
    });
  });

  it('sends a TestDelay heartbeat while awaiting login', async () => {
    await withHarness(async (harness) => {
      harness.send({ hash });
      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      const flow = harness.makeFlow(
        options({ password: 'secret', heartbeatIntervalMs: 20, loginTimeoutMs: 500 }),
      );
      const infoPromise = flow.start();
      await requestPromise;

      const heartbeat = await harness.next(
        (msg) => msg.test_delay?.from_client === true,
        500,
      );
      expect(heartbeat.test_delay?.from_client).toBe(true);

      harness.send({ login_response: { peer_info: PEER_INFO } });
      await infoPromise;
    });
  });

  it('acks early video frames and preserves them for later layers', async () => {
    await withHarness(async (harness) => {
      harness.send({ hash });
      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      const flow = harness.makeFlow(options({ password: 'secret' }));
      const infoPromise = flow.start();
      await requestPromise;

      const ackPromise = harness.next((msg) => msg.misc?.video_received === true);
      harness.send({
        video_frame: {
          timestamp: 1,
          vp9s: { frames: [{ data: Uint8Array.from([1, 2]), key: true, pts: 0 }] },
        },
      });
      expect((await ackPromise).misc?.video_received).toBe(true);

      harness.send({ login_response: { peer_info: PEER_INFO } });
      await infoPromise;
      const pending = flow.takePendingMessages();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.video_frame).toBeDefined();
    });
  });

  it('reports a peer close_reason as peer-closed', async () => {
    await withHarness(async (harness) => {
      harness.send({ hash });
      const requestPromise = harness.next((msg) => Boolean(msg.login_request));
      const flow = harness.makeFlow(options({ password: 'secret' }));
      const infoPromise = flow.start();
      await requestPromise;

      const expectation = expect(infoPromise).rejects.toMatchObject({
        code: 'peer-closed',
        message: 'kicked',
      });
      harness.send({ misc: { close_reason: 'kicked' } });
      await expectation;
    });
  });
});
