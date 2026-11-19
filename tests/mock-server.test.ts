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
import type { PeerInfo } from '../src/session/peer-info';
import type { RustDeskStatusEvent } from '../src/session/state';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_PAIRING_TIMEOUT_MS,
  MockRustDeskServer,
  waitFor,
  type MockRustDeskOptions,
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

const DEFAULT_VIDEO_SIZES = new Map([
  [1, { width: 1920, height: 1080 }],
  [2, { width: 1280, height: 720 }],
]);

interface VideoSession {
  mock: MockRustDeskServer;
  connection: RelayConnection;
  pipeline: VideoPipeline;
  peerInfo: PeerInfo;
  stats: { decoded: number[]; rebuilds: number };
  close(): Promise<void>;
}

/** Connect + login + a fake-size decoder/pipeline fed by the relay. */
async function startVideoSession(
  mockOptions: MockRustDeskOptions,
  options: {
    handleSwitches?: boolean;
    sizes?: Map<number, { width: number; height: number }>;
  } = {},
): Promise<VideoSession> {
  const mock = await MockRustDeskServer.start({ sendVideoFrame: false, ...mockOptions });
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
    const peerInfo = await flow.start();
    await waitFor(() => mock.loggedIn);

    const stats = { decoded: [] as number[], rebuilds: 0 };
    const sizes = options.sizes ?? DEFAULT_VIDEO_SIZES;
    pipeline = new VideoPipeline({
      decoder: {
        decode: async (data): Promise<Vp9Frame> => {
          const id = data[0] ?? -1;
          stats.decoded.push(id);
          const size = sizes.get(id) ?? { width: 1920, height: 1080 };
          return {
            width: size.width,
            height: size.height,
            format: { displayWidth: size.width, displayHeight: size.height },
          };
        },
        recycle: () => {},
        rebuild: async () => {
          stats.rebuilds += 1;
        },
      },
      channel: conn,
      sink: { draw: () => {} },
      initialDisplay: peerInfo.currentDisplay,
    });
    const active = pipeline;
    reader = (async () => {
      for (;;) {
        const msg = await conn.nextMessage(5000);
        if (msg.video_frame) active.push(msg.video_frame);
        else if (options.handleSwitches && msg.misc?.switch_display) {
          active.handleSwitchDisplay(msg.misc.switch_display);
        }
      }
    })().catch(() => undefined);

    return {
      mock,
      connection: conn,
      pipeline: active,
      peerInfo,
      stats,
      close: async () => {
        await active.dispose();
        flow?.dispose();
        conn.close();
        await reader;
        await mock.close();
      },
    };
  } catch (error) {
    await pipeline?.dispose();
    flow?.dispose();
    connection?.close();
    await reader;
    await mock.close();
    throw error;
  }
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
          rebuild: async () => {},
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

  it('switches displays over the relay and recovers on the new display', async () => {
    const displays: message.DisplayInfo[] = [
      { x: 0, y: 0, width: 1920, height: 1080, name: 'DP-1', online: true },
      { x: 1920, y: 0, width: 1280, height: 720, name: 'HDMI-1', online: true },
    ];
    const session = await startVideoSession(
      { displays, currentDisplay: 0 },
      { handleSwitches: true },
    );
    const { mock, pipeline, stats } = session;
    try {
      expect(session.peerInfo.displays).toHaveLength(2);
      expect(session.peerInfo.currentDisplay).toBe(0);

      mock.sendVideo([{ key: true, data: [1] }], { display: 0 });
      await waitFor(() => stats.decoded.length === 1 && mock.videoAcks === 1);

      pipeline.switchDisplay(1);
      expect(pipeline.currentDisplay).toBe(1);
      await waitFor(() => mock.switchDisplayRequests.length === 1);
      expect(mock.switchDisplayRequests[0]?.display).toBe(1);

      // A frame for another display is acked but never decoded.
      mock.sendVideo([{ key: true, data: [9] }], { display: 2 });
      await waitFor(() => mock.videoAcks === 2);
      expect(stats.decoded).toEqual([1]);
      await waitFor(() => stats.rebuilds === 1 && mock.refreshRequests >= 1);

      mock.sendSwitchDisplay({ display: 1, width: 1280, height: 720 });
      mock.sendVideo([{ key: true, data: [2] }], { display: 1 });
      await waitFor(() => stats.decoded.length === 2 && mock.videoAcks === 3);
      await pipeline.idle();
      expect(stats.decoded).toEqual([1, 2]);
      expect(pipeline.currentDisplay).toBe(1);
      expect(pipeline.awaitingKeyframe).toBe(false);
      expect(stats.rebuilds).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('rebuilds after a resolution change over the relay', async () => {
    const session = await startVideoSession({});
    const { mock, pipeline, stats } = session;
    try {
      mock.sendVideo([{ key: true, data: [1] }]);
      await waitFor(() => stats.decoded.length === 1 && mock.videoAcks === 1);

      mock.sendVideo([{ key: true, data: [2] }]);
      await waitFor(() => stats.decoded.length === 2);
      await waitFor(() => stats.rebuilds === 1 && mock.refreshRequests >= 1);
      expect(pipeline.awaitingKeyframe).toBe(true);

      mock.sendVideo([{ key: true, data: [2] }]);
      await waitFor(() => stats.decoded.length === 3 && mock.videoAcks === 3);
      await pipeline.idle();
      expect(pipeline.awaitingKeyframe).toBe(false);
      expect(stats.rebuilds).toBe(1);
    } finally {
      await session.close();
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
