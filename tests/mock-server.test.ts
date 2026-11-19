import { describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { challengeResponse } from '../src/crypto/password';
import {
  connectRelay,
  type RelayConnection,
  type RendezvousConnectOptions,
} from '../src/protocol/connection';
import { LoginFlow } from '../src/protocol/login';
import type { Vp9Frame } from '../src/media/vp9-decoder';
import { VideoPipeline } from '../src/media/video-pipeline';
import * as message from '../src/protocol/message';
import { WebSock, type WebSocketLike, type WebSockCloseEvent } from '../src/protocol/websock';
import type { RustDeskStatusEvent } from '../src/session/state';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_PAIRING_TIMEOUT_MS,
  MockRustDeskServer,
  waitFor,
} from './mocks/rustdesk-mock';

// P1-8 acceptance: one mock process plays hbbs + hbbr + the controlled peer.
// These tests exercise the real client stack (connect + login + encrypted
// input) against it, plus pairing/idle/size limits and failure scenarios.

const createSocket = (url: string): WebSocketLike =>
  new WsClient(url) as unknown as WebSocketLike;

function connectionOptions(
  mock: MockRustDeskServer,
  overrides: Partial<RendezvousConnectOptions> = {},
): RendezvousConnectOptions {
  return {
    server: mock.server,
    secure: false,
    peerId: mock.peerId,
    serverKey: mock.serverKey,
    openTimeoutMs: 1000,
    responseTimeoutMs: 1000,
    securingTimeoutMs: 2000,
    createSocket,
    ...overrides,
  };
}

describe('mock hbbs/hbbr/peer integration', () => {
  it('connects, logs in, receives a synthetic frame and records input', async () => {
    const mock = await MockRustDeskServer.start();
    let connection: RelayConnection | undefined;
    let flow: LoginFlow | undefined;
    try {
      connection = await connectRelay(connectionOptions(mock));
      expect(connection.secure).toBe(true);

      flow = new LoginFlow(connection, {
        peerId: mock.peerId,
        password: mock.password,
        loginTimeoutMs: 2000,
      });
      const info = await flow.start();
      expect(info).toMatchObject({
        username: 'alice',
        hostname: 'mock-desktop',
        platform: 'Linux',
        currentDisplay: 0,
        sasEnabled: false,
        version: '1.5.3',
        connectionId: 42,
        privacyMode: false,
      });
      expect(info.displays[0]).toMatchObject({ width: 1920, height: 1080 });

      await waitFor(() => mock.loggedIn);
      expect(mock.loginRequests).toHaveLength(1);
      const login = mock.loginRequests[0]!;
      expect(Array.from(login.password)).toEqual(
        Array.from(challengeResponse(mock.password, mock.salt, mock.challenge)),
      );
      expect(login).toMatchObject({
        username: mock.peerId,
        my_id: 'web',
        my_name: 'web',
      });
      expect(login.option?.disable_audio).toBe(message.OptionMessage_BoolOption.Yes);
      expect(login.version).toBe('');
      expect(login.my_platform).toBe('');

      expect(mock.punchHoleRequests[0]).toMatchObject({
        id: mock.peerId,
        licence_key: mock.serverKey,
      });
      expect(mock.relayRequests).toHaveLength(2);
      for (const request of mock.relayRequests) {
        expect(request.licence_key).toBe(mock.serverKey);
      }

      const pendingVideo = flow.takePendingMessages().find((msg) => msg.video_frame);
      const video = pendingVideo ?? (await connection.nextMessage(1000));
      expect(video.video_frame?.vp9s?.frames[0]?.key).toBe(true);

      connection.sendMessage({
        mouse_event: { mask: 1, x: 12, y: 34, modifiers: [] },
      });
      connection.sendMessage({
        key_event: { down: true, chr: 65, modifiers: [] },
      });
      connection.sendMessage({
        clipboard: {
          format: message.ClipboardFormat.Text,
          content: new TextEncoder().encode('hello'),
        },
      });

      await waitFor(() => mock.inputs.length >= 3);
      expect(mock.inputs.find((msg) => msg.mouse_event)?.mouse_event).toMatchObject({
        mask: 1,
        x: 12,
        y: 34,
      });
      expect(mock.inputs.find((msg) => msg.key_event)?.key_event).toMatchObject({
        down: true,
        chr: 65,
      });
      const clipboard = mock.inputs.find((msg) => msg.clipboard)?.clipboard;
      expect(clipboard?.format).toBe(message.ClipboardFormat.Text);
      expect(new TextDecoder().decode(clipboard?.content)).toBe('hello');
    } finally {
      flow?.dispose();
      connection?.close();
      await mock.close();
    }
  });

  it('acks every video batch and requests a keyframe after a drop', async () => {
    const mock = await MockRustDeskServer.start({ sendVideoFrame: false });
    let connection: RelayConnection | undefined;
    let flow: LoginFlow | undefined;
    let pipeline: VideoPipeline | undefined;
    let reader: Promise<void> | undefined;
    try {
      const conn = await connectRelay(connectionOptions(mock));
      connection = conn;
      flow = new LoginFlow(conn, {
        peerId: mock.peerId,
        password: mock.password,
        loginTimeoutMs: 2000,
      });
      await flow.start();
      await waitFor(() => mock.loggedIn);

      const decoded: number[] = [];
      pipeline = new VideoPipeline({
        decoder: {
          decode: async (data): Promise<Vp9Frame> => {
            decoded.push(data[0] ?? -1);
            return { width: 1, height: 1 };
          },
          recycle: () => {},
        },
        channel: conn,
        sink: { draw: () => {} },
      });
      reader = (async () => {
        for (;;) {
          const msg = await conn.nextMessage(5000);
          if (msg.video_frame) pipeline!.push(msg.video_frame);
        }
      })().catch(() => undefined);

      // The pipeline starts awaiting a keyframe: a delta-only batch is acked
      // and triggers a refresh, but is not decoded.
      mock.sendVideo([{ key: false, data: [9] }]);
      await waitFor(() => mock.videoAcks === 1 && mock.refreshRequests >= 1);
      expect(decoded).toEqual([]);

      mock.sendVideo([
        { key: true, data: [1] },
        { key: false, data: [2] },
      ]);
      await waitFor(() => mock.videoAcks === 2 && decoded.length === 2);
      await pipeline.idle();
      expect(decoded).toEqual([1, 2]);
      expect(pipeline.awaitingKeyframe).toBe(false);
    } finally {
      pipeline?.dispose();
      flow?.dispose();
      connection?.close();
      await reader;
      await mock.close();
    }
  });

  it('accepts /ws/id and /ws/relay path endpoints', async () => {
    const mock = await MockRustDeskServer.start();
    let connection: RelayConnection | undefined;
    try {
      connection = await connectRelay(
        connectionOptions(mock, {
          rendezvousUrl: mock.rendezvousUrl,
          relayUrl: mock.relayUrl,
        }),
      );
      expect(connection.secure).toBe(true);
      expect(mock.rendezvousPaths.some((path) => path.startsWith('/ws/id'))).toBe(true);
      expect(mock.relayPaths.some((path) => path.startsWith('/ws/relay'))).toBe(true);
    } finally {
      connection?.close();
      await mock.close();
    }
  });

  it('reports an offline peer', async () => {
    const mock = await MockRustDeskServer.start({ mode: 'offline' });
    try {
      await expect(connectRelay(connectionOptions(mock))).rejects.toMatchObject({
        code: 'peer-offline',
      });
    } finally {
      await mock.close();
    }
  });

  it('reports a refused relay', async () => {
    const mock = await MockRustDeskServer.start({
      mode: 'refuse',
      relayRefuseReason: 'not today',
    });
    try {
      await expect(connectRelay(connectionOptions(mock))).rejects.toMatchObject({
        code: 'rendezvous-refused',
        message: 'Relay refused: not today',
      });
    } finally {
      await mock.close();
    }
  });

  it('rejects a client configured with the wrong server key', async () => {
    const mock = await MockRustDeskServer.start();
    try {
      const wrongKey = Buffer.from(new Uint8Array(32).fill(0x77)).toString('base64');
      await expect(
        connectRelay(connectionOptions(mock, { serverKey: wrongKey })),
      ).rejects.toMatchObject({ code: 'server-key-invalid' });
    } finally {
      await mock.close();
    }
  });

  it('retries a wrong password over the same full connection', async () => {
    const mock = await MockRustDeskServer.start();
    let connection: RelayConnection | undefined;
    let flow: LoginFlow | undefined;
    let resolvePrompt!: (event: RustDeskStatusEvent) => void;
    const prompted = new Promise<RustDeskStatusEvent>((resolve) => {
      resolvePrompt = resolve;
    });
    try {
      connection = await connectRelay(connectionOptions(mock));
      flow = new LoginFlow(connection, {
        peerId: mock.peerId,
        password: 'wrong-password',
        loginTimeoutMs: 2000,
        onStatus: (event) => {
          if (event.status === 'password-required') resolvePrompt(event);
        },
      });
      const infoPromise = flow.start();

      const prompt = await prompted;
      expect(prompt).toMatchObject({ status: 'password-required', retry: true });
      flow.login(mock.password);

      await expect(infoPromise).resolves.toMatchObject({ username: 'alice' });
      expect(mock.loginRequests).toHaveLength(2);
      expect(Array.from(mock.loginRequests[1]!.password)).toEqual(
        Array.from(challengeResponse(mock.password, mock.salt, mock.challenge)),
      );
    } finally {
      flow?.dispose();
      connection?.close();
      await mock.close();
    }
  });

  it('closes an unpaired hbbr leg after the pairing timeout', async () => {
    expect(DEFAULT_PAIRING_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(30_000);

    const mock = await MockRustDeskServer.start({ pairingTimeoutMs: 40 });
    const sock = new WebSock(mock.relayUrl, { createSocket });
    try {
      await sock.open(1000);
      const closed = new Promise<WebSockCloseEvent>((resolve) => {
        sock.on('close', resolve);
      });
      sock.sendRendezvous({
        request_relay: { uuid: 'never-paired', licence_key: mock.serverKey },
      });
      expect(await closed).toMatchObject({ code: 1001, reason: 'pairing timeout' });
    } finally {
      sock.close();
      await mock.close();
    }
  });

  it('closes an idle paired session after the idle timeout', async () => {
    const mock = await MockRustDeskServer.start({
      idleTimeoutMs: 60,
      sendVideoFrame: false,
    });
    let connection: RelayConnection | undefined;
    let flow: LoginFlow | undefined;
    try {
      connection = await connectRelay(connectionOptions(mock));
      flow = new LoginFlow(connection, {
        peerId: mock.peerId,
        password: mock.password,
        loginTimeoutMs: 2000,
      });
      await flow.start();

      await expect(connection.nextMessage(1000)).rejects.toMatchObject({
        code: 'connection-lost',
      });
    } finally {
      flow?.dispose();
      connection?.close();
      await mock.close();
    }
  });

  it('closes hbbs on an oversized rendezvous frame', async () => {
    const mock = await MockRustDeskServer.start({ maxRendezvousBytes: 64 });
    try {
      await expect(
        connectRelay(connectionOptions(mock, { peerId: 'x'.repeat(200) })),
      ).rejects.toMatchObject({ code: 'message-too-large' });
    } finally {
      await mock.close();
    }
  });

  it('closes hbbr on an oversized relay frame', async () => {
    const mock = await MockRustDeskServer.start({
      maxRelayBytes: 512,
      sendVideoFrame: false,
    });
    let connection: RelayConnection | undefined;
    let flow: LoginFlow | undefined;
    try {
      connection = await connectRelay(connectionOptions(mock));
      flow = new LoginFlow(connection, {
        peerId: mock.peerId,
        password: mock.password,
        loginTimeoutMs: 2000,
      });
      await flow.start();

      connection.sendMessage({
        key_event: { down: true, seq: 'x'.repeat(2000), modifiers: [] },
      });
      await expect(connection.nextMessage(1000)).rejects.toMatchObject({
        code: 'message-too-large',
      });
    } finally {
      flow?.dispose();
      connection?.close();
      await mock.close();
    }
  });
});
