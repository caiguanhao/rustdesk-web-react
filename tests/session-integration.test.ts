import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { challengeResponse } from '../src/crypto/password';
import { loadSodium } from '../src/crypto/sodium';
import type { RemoteClipboardEvent } from '../src/input/clipboard';
import {
  ClipboardFormat,
  PermissionInfo_Permission,
} from '../src/protocol/message';
import type { WebSocketLike } from '../src/protocol/websock';
import { RustDeskError } from '../src/session/errors';
import type {
  RustDeskServerKeyVerifier,
  RustDeskSessionConfig,
} from '../src/session/options';
import { RustDeskSession } from '../src/session/RustDeskSession';
import type { RustDeskStatusEvent } from '../src/session/state';
import { h1Base64 } from './mocks/credentials';
import { MockRustDeskServer, waitFor } from './mocks/rustdesk-mock';

// P4-1 integration: the real encrypted mock hbbs/hbbr/peer drives connect,
// login retry, post-login video acks, permission revocation, clipboard and
// close_reason through RustDeskSession's own loop.

const createSocket = (url: string): WebSocketLike =>
  new WsClient(url) as unknown as WebSocketLike;

const sessions: RustDeskSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
});

interface Harness {
  session: RustDeskSession;
  statuses: RustDeskStatusEvent[];
  errors: RustDeskError[];
  clipboards: RemoteClipboardEvent[];
}

function makeHarness(
  mock: MockRustDeskServer | undefined,
  config: Partial<RustDeskSessionConfig> = {},
): Harness {
  const statuses: RustDeskStatusEvent[] = [];
  const errors: RustDeskError[] = [];
  const clipboards: RemoteClipboardEvent[] = [];
  const base: RustDeskSessionConfig = mock
    ? {
        server: mock.server,
        serverKey: mock.serverKey,
        id: mock.peerId,
        password: mock.password,
      }
    : { server: '127.0.0.1:1', id: 'unreachable' };
  const session = new RustDeskSession(
    { ...base, ...config },
    {
      secure: false,
      createSocket,
      autoCopyClipboard: false,
      heartbeatIntervalMs: 1_000,
    },
  );
  session.on('status', (event) => statuses.push(event));
  session.on('error', (error) => errors.push(error));
  session.on('clipboard', (event) => clipboards.push(event));
  sessions.push(session);
  return { session, statuses, errors, clipboards };
}

/** Bind and release an ephemeral TCP port, then return it (no listener). */
async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function verifierFor(payload: string): Promise<RustDeskServerKeyVerifier> {
  const sodium = await loadSodium();
  const keys = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(0x55));
  const signed = sodium.crypto_sign(
    new TextEncoder().encode(payload),
    keys.privateKey,
  );
  return {
    publicKey: Buffer.from(keys.publicKey).toString('base64'),
    verifier: Buffer.from(signed).toString('base64'),
  };
}

describe('RustDeskSession over the mock relay', () => {
  it('connects, acks video, routes permissions/clipboard and reports peer close', async () => {
    const mock = await MockRustDeskServer.start();
    try {
      const harness = makeHarness(mock);
      const info = await harness.session.connect();
      expect(info.username).toBe('alice');
      expect(harness.session.status).toBe('connected');
      expect(harness.statuses.map((event) => event.status)).toEqual(
        expect.arrayContaining([
          'connecting',
          'securing',
          'authenticating',
          'connected',
        ]),
      );

      await waitFor(() => mock.videoAcks >= 1, 2000);

      mock.sendPermissionInfo(
        PermissionInfo_Permission.Keyboard,
        false,
      );
      await waitFor(
        () => harness.errors.some((error) => error.code === 'no-permission'),
        2000,
      );
      expect(harness.session.permissions.policy.mouse).toBe(false);

      mock.sendPermissionInfo(PermissionInfo_Permission.Keyboard, true);
      await waitFor(() => harness.session.permissions.policy.mouse, 2000);
      expect(harness.session.sendText('本地文本')).toBe(true);
      await waitFor(
        () => mock.inputs.some((message) => message.clipboard),
        2000,
      );
      const sent = mock.inputs.find((message) => message.clipboard)?.clipboard;
      expect(sent?.format).toBe(ClipboardFormat.Text);
      expect(new TextDecoder().decode(sent?.content)).toBe('本地文本');

      mock.sendClipboard({
        format: ClipboardFormat.Text,
        compress: false,
        content: new TextEncoder().encode('remote text'),
      });
      await waitFor(() => harness.clipboards.length === 1, 2000);
      expect(harness.clipboards[0]).toEqual({
        text: 'remote text',
        copied: false,
      });

      mock.sendCloseReason('maintenance');
      await waitFor(
        () => harness.session.status === 'disconnected',
        2000,
      );
      expect(harness.statuses.at(-1)).toMatchObject({
        status: 'disconnected',
        detail: 'maintenance',
      });
    } finally {
      await mock.close();
    }
  });

  it('retries a wrong password on the same connection', async () => {
    const mock = await MockRustDeskServer.start({
      password: 'real-password',
      sendVideoFrame: false,
    });
    try {
      const harness = makeHarness(mock, { password: 'wrong' });
      const connecting = harness.session.connect();
      await waitFor(
        () =>
          harness.statuses.some(
            (event) =>
              event.status === 'password-required' && event.retry === true,
          ),
        5000,
      );
      const info = await harness.session.login('real-password');
      await connecting;

      expect(info.username).toBe('alice');
      expect(harness.session.status).toBe('connected');
      expect(mock.loginRequests).toHaveLength(2);
    } finally {
      await mock.close();
    }
  });
});

describe('failure scenarios (P5-4)', () => {
  async function expectFailure(
    harness: Harness,
    code: string,
  ): Promise<void> {
    await expect(harness.session.connect()).rejects.toMatchObject({ code });
    expect(harness.statuses.at(-1)).toMatchObject({ status: 'error' });
    expect(harness.errors.at(-1)).toMatchObject({ code });
  }

  it('reports an offline peer', async () => {
    const mock = await MockRustDeskServer.start({ mode: 'offline' });
    try {
      await expectFailure(makeHarness(mock), 'peer-offline');
    } finally {
      await mock.close();
    }
  });

  it('reports a wrong server key', async () => {
    const mock = await MockRustDeskServer.start();
    try {
      await expectFailure(
        makeHarness(mock, {
          serverKey: Buffer.from(new Uint8Array(32).fill(0x77)).toString(
            'base64',
          ),
        }),
        'server-key-invalid',
      );
    } finally {
      await mock.close();
    }
  });

  it('reports an unreachable server', async () => {
    const port = await unusedPort();
    const harness = makeHarness(undefined, {
      rendezvousUrl: `ws://127.0.0.1:${port}/ws/id`,
      relayUrl: `ws://127.0.0.1:${port}/ws/relay`,
    });
    await expectFailure(harness, 'server-unreachable');
  });

  it('reports a reverse-proxy 1009 during the session', async () => {
    const mock = await MockRustDeskServer.start({
      maxRelayBytes: 512,
      sendVideoFrame: false,
    });
    try {
      const harness = makeHarness(mock);
      await harness.session.connect();
      harness.session.sendMessage({
        key_event: { down: true, seq: 'x'.repeat(2000), modifiers: [] },
      });
      await waitFor(() => harness.session.status === 'error', 2000);
      expect(harness.errors.at(-1)).toMatchObject({ code: 'message-too-large' });
      expect(harness.statuses.at(-1)).toMatchObject({ status: 'error' });
    } finally {
      await mock.close();
    }
  });

  it('reports a server shutdown after connect as connection-lost', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    try {
      const harness = makeHarness(mock);
      await harness.session.connect();
      expect(harness.session.status).toBe('connected');

      await mock.close();
      await waitFor(() => harness.session.status === 'error', 2000);
      expect(harness.errors.at(-1)).toMatchObject({ code: 'connection-lost' });
      expect(harness.statuses.at(-1)).toMatchObject({ status: 'error' });
    } finally {
      await mock.close();
    }
  });

  it('connects with a bare base64 h1 and with an object h1', async () => {
    for (const passwordHash of [
      h1Base64('mock-password', 'mock-salt'),
      { hash: h1Base64('mock-password', 'mock-salt'), salt: 'mock-salt' },
    ]) {
      const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
      try {
        const harness = makeHarness(mock, {
          password: undefined,
          passwordHash,
        });
        const info = await harness.session.connect();
        expect(info.username).toBe('alice');
        expect(mock.loginRequests).toHaveLength(1);
        expect(Array.from(mock.loginRequests[0]!.password)).toEqual(
          Array.from(challengeResponse('mock-password', 'mock-salt', 'mock-challenge')),
        );
      } finally {
        await mock.close();
      }
    }
  });

  it('retries a wrong h1 with the correct h1 on the same Hash', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    try {
      const harness = makeHarness(mock, {
        password: undefined,
        passwordHash: {
          hash: h1Base64('wrong', 'mock-salt'),
          salt: 'mock-salt',
        },
      });
      const promise = harness.session.connect();
      await waitFor(
        () =>
          harness.statuses.some(
            (event) => event.status === 'password-required' && event.retry,
          ),
        2000,
      );
      const login = harness.session.login({
        hash: h1Base64('mock-password', 'mock-salt'),
        salt: 'mock-salt',
      });
      await login;
      await promise;
      expect(mock.loginRequests).toHaveLength(2);
      expect(Array.from(mock.loginRequests[1]!.password)).toEqual(
        Array.from(challengeResponse('mock-password', 'mock-salt', 'mock-challenge')),
      );
    } finally {
      await mock.close();
    }
  });

  it('prompts on a salt mismatch without sending a login request', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    try {
      const h1 = h1Base64('mock-password', 'mock-salt');
      const harness = makeHarness(mock, {
        password: undefined,
        passwordHash: { hash: h1, salt: 'other-salt' },
      });
      const promise = harness.session.connect();
      await waitFor(
        () =>
          harness.statuses.some(
            (event) =>
              event.status === 'password-required' &&
              event.detail === 'Password hash salt mismatch',
          ),
        2000,
      );
      expect(mock.loginRequests).toHaveLength(0);

      const login = harness.session.login({ hash: h1, salt: 'mock-salt' });
      await login;
      await promise;
      expect(mock.loginRequests).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  it('uses a serverKeyProvider key and falls back to the static key', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    try {
      const providerHarness = makeHarness(mock, {
        serverKey: undefined,
        serverKeyProvider: async () => mock.serverKey,
      });
      await providerHarness.session.connect();
      expect(mock.punchHoleRequests[0]?.licence_key).toBe(mock.serverKey);
      await providerHarness.session.dispose();

      const staticHarness = makeHarness(mock, {
        serverKeyProvider: () => undefined,
      });
      await staticHarness.session.connect();
      expect(mock.punchHoleRequests[1]?.licence_key).toBe(mock.serverKey);
      await staticHarness.session.dispose();
    } finally {
      await mock.close();
    }
  });

  it('accepts verifier payloads and prefers a provider key', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    try {
      for (const payload of [`1000::${mock.serverKey}`, mock.serverKey]) {
        const harness = makeHarness(mock, {
          serverKey: undefined,
          serverKeyVerifier: await verifierFor(payload),
        });
        await harness.session.connect();
        await harness.session.dispose();
      }
      expect(mock.punchHoleRequests.map((request) => request.licence_key)).toEqual([
        mock.serverKey,
        mock.serverKey,
      ]);

      const providerHarness = makeHarness(mock, {
        serverKey: undefined,
        serverKeyVerifier: { publicKey: 'bad', verifier: 'bad' },
        serverKeyProvider: async () => mock.serverKey,
      });
      await providerHarness.session.connect();
      expect(mock.punchHoleRequests.at(-1)?.licence_key).toBe(mock.serverKey);
      await providerHarness.session.dispose();
    } finally {
      await mock.close();
    }
  });

  it('fails closed on provider/verifier errors even with allowInsecureFallback', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    try {
      const providerHarness = makeHarness(mock, {
        serverKey: undefined,
        allowInsecureFallback: true,
        serverKeyProvider: () => {
          throw new Error('provider failed');
        },
      });
      await expect(providerHarness.session.connect()).rejects.toMatchObject({
        code: 'server-key-missing',
      });
      expect(mock.punchHoleRequests).toHaveLength(0);
      expect(providerHarness.statuses.some((event) => event.status === 'securing')).toBe(false);

      const verifierHarness = makeHarness(mock, {
        serverKey: mock.serverKey,
        allowInsecureFallback: true,
        serverKeyVerifier: { publicKey: 'bad', verifier: 'bad' },
      });
      await expect(verifierHarness.session.connect()).rejects.toMatchObject({
        code: 'server-key-invalid',
      });
      expect(mock.punchHoleRequests).toHaveLength(0);
      expect(verifierHarness.statuses.some((event) => event.status === 'securing')).toBe(false);
    } finally {
      await mock.close();
    }
  });
});
