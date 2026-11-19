/**
 * In-process RustDesk server + controlled peer for integration tests.
 *
 * - hbbs: receives PunchHoleRequest, returns RelayResponse (signed IdPk),
 *   or offline / refusal responses.
 * - hbbr: accepts `/ws/relay`, pairs two RequestRelay legs by uuid, forwards
 *   binary frames, and enforces pairing/idle/message-size limits.
 * - controlled peer: performs SignedId/PublicKey, verifies the boxed
 *   secretbox key, sends Hash, validates LoginRequest (Wrong Password
 *   supported), returns PeerInfo, sends a synthetic VP9 frame and records
 *   decrypted input messages for assertions.
 *
 * Defaults mirror the real server: 64 KiB rendezvous frames, 64 MiB relay
 * frames, 30 s pairing and 30 s idle timeouts.
 */
import { once } from 'node:events';
import { WebSocket as WsClient, WebSocketServer, type RawData } from 'ws';
import { challengeResponse } from '../../src/crypto/password';
import {
  createSecretBoxCipher,
  generateBoxKeyPair,
  openSecret,
  type BoxKeyPair,
} from '../../src/crypto/handshake';
import type { Sodium } from '../../src/crypto/sodium';
import { loadSodium } from '../../src/crypto/sodium';
import * as message from '../../src/protocol/message';
import type { DeepPartial } from '../../src/protocol/message';
import * as rendezvous from '../../src/protocol/rendezvous';

export const DEFAULT_PAIRING_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RENDEZVOUS_BYTES = 64 * 1024;
export const DEFAULT_MAX_RELAY_BYTES = 64 * 1024 * 1024;

export interface MockRustDeskOptions {
  peerId?: string;
  password?: string;
  /** hbbs failure mode. `refuse` uses `relayRefuseReason`. */
  mode?: 'success' | 'offline' | 'refuse';
  relayRefuseReason?: string;
  pairingTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxRendezvousBytes?: number;
  maxRelayBytes?: number;
  /** Send one encrypted synthetic VP9 frame after peer_info (default true). */
  sendVideoFrame?: boolean;
  /** Display list returned in peer_info (default one 1920x1080 display). */
  displays?: message.DisplayInfo[];
  /** Initial `peer_info.current_display` (default 0). */
  currentDisplay?: number;
}

function rawToBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

const encodeMessage = (partial: DeepPartial<message.Message>): Uint8Array =>
  message.Message.encode(message.Message.fromPartial(partial)).finish();

const decodeMessage = (bytes: Uint8Array): message.Message => message.Message.decode(bytes);

const encodeRendezvous = (
  partial: DeepPartial<rendezvous.RendezvousMessage>,
): Uint8Array =>
  rendezvous.RendezvousMessage.encode(
    rendezvous.RendezvousMessage.fromPartial(partial),
  ).finish();

const decodeRendezvous = (bytes: Uint8Array): rendezvous.RendezvousMessage =>
  rendezvous.RendezvousMessage.decode(bytes);

const seed = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** Poll a condition; test-only convenience. */
export function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor timed out'));
      }
    }, 5);
  });
}

/** Async frame queue over one WebSocket (used by the controlled peer). */
class FrameQueue {
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: {
    resolve: (bytes: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  private failure: Error | undefined;

  constructor(socket: WsClient) {
    socket.on('message', (data) => this.push(rawToBytes(data)));
    socket.on('close', () => this.fail(new Error('peer socket closed')));
    socket.on('error', (error) => this.fail(error));
  }

  next(timeoutMs = 1000): Promise<Uint8Array> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('peer frame timeout'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private push(bytes: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(bytes);
    } else {
      this.queue.push(bytes);
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

export class MockRustDeskServer {
  readonly peerId: string;
  readonly password: string;
  readonly salt = 'mock-salt';
  readonly challenge = 'mock-challenge';
  readonly peerInfo: message.PeerInfo;

  readonly punchHoleRequests: rendezvous.PunchHoleRequest[] = [];
  readonly relayRequests: rendezvous.RequestRelay[] = [];
  readonly loginRequests: message.LoginRequest[] = [];
  readonly switchDisplayRequests: message.SwitchDisplay[] = [];
  readonly inputs: message.Message[] = [];
  readonly rendezvousPaths: string[] = [];
  readonly relayPaths: string[] = [];

  serverKey = '';
  rendezvousUrl = '';
  relayUrl = '';
  rendezvousPort = 0;
  relayPort = 0;
  loggedIn = false;
  videoAcks = 0;
  refreshRequests = 0;
  peerError: unknown;
  private peerSend: ((partial: DeepPartial<message.Message>) => void) | undefined;

  private readonly options: Required<
    Pick<
      MockRustDeskOptions,
      | 'mode'
      | 'pairingTimeoutMs'
      | 'idleTimeoutMs'
      | 'maxRendezvousBytes'
      | 'maxRelayBytes'
      | 'sendVideoFrame'
    >
  > &
    MockRustDeskOptions;
  private sodium!: Sodium;
  private hbbs!: WebSocketServer;
  private hbbr!: WebSocketServer;
  private serverSignedIdPk!: Uint8Array;
  private peerBoxKeys!: BoxKeyPair;
  private peerSignKeys!: { publicKey: Uint8Array; privateKey: Uint8Array };
  private readonly pairingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleTimers = new Set<ReturnType<typeof setTimeout>>();
  private peerClient: WsClient | undefined;
  private readonly legs = new Map<string, WsClient[]>();

  private constructor(options: MockRustDeskOptions) {
    this.options = {
      mode: 'success',
      pairingTimeoutMs: DEFAULT_PAIRING_TIMEOUT_MS,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      maxRendezvousBytes: DEFAULT_MAX_RENDEZVOUS_BYTES,
      maxRelayBytes: DEFAULT_MAX_RELAY_BYTES,
      sendVideoFrame: true,
      ...options,
    };
    this.peerId = options.peerId ?? '123456789';
    this.password = options.password ?? 'mock-password';
    this.peerInfo = message.PeerInfo.fromPartial({
      username: 'alice',
      hostname: 'mock-desktop',
      platform: 'Linux',
      displays: options.displays ?? [
        { x: 0, y: 0, width: 1920, height: 1080, name: 'DP-1', online: true },
      ],
      current_display: options.currentDisplay ?? 0,
      sas_enabled: false,
      version: '1.5.3',
      conn_id: 42,
      features: { privacy_mode: false },
    });
  }

  static async start(options: MockRustDeskOptions = {}): Promise<MockRustDeskServer> {
    const server = new MockRustDeskServer(options);
    await server.init();
    return server;
  }

  get server(): string {
    return `127.0.0.1:${this.rendezvousPort - 2}`;
  }

  get relayServer(): string {
    return `127.0.0.1:${this.relayPort - 2}`;
  }

  /** Send one VideoFrame batch from the controlled peer (after login). */
  sendVideo(
    frames: { key: boolean; data?: number[] }[],
    options: { display?: number } = {},
  ): void {
    if (!this.peerSend) throw new Error('mock peer is not logged in yet');
    this.peerSend({
      video_frame: {
        timestamp: Date.now(),
        display: options.display ?? 0,
        vp9s: {
          frames: frames.map((frame, index) => ({
            data: Uint8Array.from(frame.data ?? [index + 1]),
            key: frame.key,
            pts: index,
          })),
        },
      },
    });
  }

  /** Send the server's display-change echo/metadata. */
  sendSwitchDisplay(sw: DeepPartial<message.SwitchDisplay>): void {
    if (!this.peerSend) throw new Error('mock peer is not logged in yet');
    this.peerSend({
      misc: {
        switch_display: message.SwitchDisplay.fromPartial(sw),
      },
    });
  }

  async close(): Promise<void> {
    for (const timer of this.pairingTimers.values()) clearTimeout(timer);
    for (const timer of this.idleTimers) clearTimeout(timer);
    this.pairingTimers.clear();
    this.idleTimers.clear();
    this.peerClient?.terminate();
    for (const server of [this.hbbs, this.hbbr]) {
      for (const client of server.clients) client.terminate();
    }
    await Promise.all([
      new Promise<void>((resolve) => this.hbbs.close(() => resolve())),
      new Promise<void>((resolve) => this.hbbr.close(() => resolve())),
    ]);
  }

  private async init(): Promise<void> {
    this.sodium = await loadSodium();
    const hbbsKeys = this.sodium.crypto_sign_seed_keypair(seed(0x11));
    this.peerSignKeys = this.sodium.crypto_sign_seed_keypair(seed(0x22));
    this.peerBoxKeys = await generateBoxKeyPair();
    this.serverKey = Buffer.from(hbbsKeys.publicKey).toString('base64');
    this.serverSignedIdPk = this.signIdPk(
      this.peerId,
      this.peerSignKeys.publicKey,
      hbbsKeys.privateKey,
    );

    this.hbbr = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.hbbs = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await Promise.all([once(this.hbbr, 'listening'), once(this.hbbs, 'listening')]);

    const relayAddress = this.hbbr.address();
    const rendezvousAddress = this.hbbs.address();
    if (
      relayAddress === null ||
      typeof relayAddress === 'string' ||
      rendezvousAddress === null ||
      typeof rendezvousAddress === 'string'
    ) {
      throw new Error('mock server has no port');
    }
    if (relayAddress.port <= 1024 || rendezvousAddress.port <= 1024) {
      throw new Error('ephemeral port too low for the +2 rule');
    }
    this.relayPort = relayAddress.port;
    this.rendezvousPort = rendezvousAddress.port;
    this.rendezvousUrl = `ws://127.0.0.1:${this.rendezvousPort}/ws/id`;
    this.relayUrl = `ws://127.0.0.1:${this.relayPort}/ws/relay`;

    this.hbbs.on('connection', (socket, request) => {
      this.rendezvousPaths.push(request.url ?? '');
      this.onRendezvousConnection(socket);
    });
    this.hbbr.on('connection', (socket, request) => {
      this.relayPaths.push(request.url ?? '');
      this.onRelayConnection(socket);
    });
  }

  private signIdPk(id: string, pk: Uint8Array, privateKey: Uint8Array): Uint8Array {
    const payload = message.IdPk.encode(message.IdPk.fromPartial({ id, pk })).finish();
    return this.sodium.crypto_sign(payload, privateKey);
  }

  private onRendezvousConnection(socket: WsClient): void {
    socket.on('message', (data) => {
      const raw = rawToBytes(data);
      if (raw.length > this.options.maxRendezvousBytes) {
        socket.close(1009, 'rendezvous message too big');
        return;
      }
      let msg: rendezvous.RendezvousMessage;
      try {
        msg = decodeRendezvous(raw);
      } catch {
        socket.close(1002, 'invalid rendezvous frame');
        return;
      }
      const request = msg.punch_hole_request;
      if (!request) {
        socket.close(1002, 'expected PunchHoleRequest');
        return;
      }
      this.punchHoleRequests.push(request);

      if (this.options.mode === 'offline') {
        socket.send(
          encodeRendezvous({
            punch_hole_response: {
              failure: rendezvous.PunchHoleResponse_Failure.OFFLINE,
            },
          }),
        );
        return;
      }
      if (this.options.mode === 'refuse') {
        socket.send(
          encodeRendezvous({
            relay_response: {
              refuse_reason: this.options.relayRefuseReason ?? 'refused by mock',
            },
          }),
        );
        return;
      }

      const uuid = `mock-${this.punchHoleRequests.length}`;
      socket.send(
        encodeRendezvous({
          relay_response: {
            uuid,
            relay_server: this.relayServer,
            pk: this.serverSignedIdPk,
            version: '1.5.3',
          },
        }),
      );
      void this.startPeer(uuid);
    });
  }

  private async startPeer(uuid: string): Promise<void> {
    try {
      const peer = new WsClient(this.relayUrl);
      this.peerClient = peer;
      await once(peer, 'open');
      peer.send(
        encodeRendezvous({
          request_relay: { uuid, licence_key: this.serverKey },
        }),
      );
    } catch (error) {
      this.peerError = error;
    }
  }

  private onRelayConnection(socket: WsClient): void {
    socket.once('message', (data) => {
      const raw = rawToBytes(data);
      if (raw.length > this.options.maxRelayBytes) {
        socket.close(1009, 'relay message too big');
        return;
      }
      let request: rendezvous.RequestRelay | undefined;
      try {
        request = decodeRendezvous(raw).request_relay;
      } catch {
        socket.close(1002, 'invalid relay frame');
        return;
      }
      if (!request || !request.uuid) {
        socket.close(1002, 'expected RequestRelay');
        return;
      }
      this.relayRequests.push(request);

      const legs = this.legs.get(request.uuid) ?? [];
      legs.push(socket);
      this.legs.set(request.uuid, legs);
      if (legs.length === 1) {
        const timer = setTimeout(() => {
          this.pairingTimers.delete(request!.uuid);
          this.legs.delete(request!.uuid);
          socket.close(1001, 'pairing timeout');
        }, this.options.pairingTimeoutMs);
        this.pairingTimers.set(request.uuid, timer);
        socket.once('close', () => {
          clearTimeout(timer);
          if (this.pairingTimers.get(request!.uuid) === timer) {
            this.pairingTimers.delete(request!.uuid);
          }
          this.legs.delete(request!.uuid);
        });
        return;
      }

      const pairingTimer = this.pairingTimers.get(request.uuid);
      if (pairingTimer) {
        clearTimeout(pairingTimer);
        this.pairingTimers.delete(request.uuid);
      }
      this.legs.delete(request.uuid);
      const [first, second] = legs as [WsClient, WsClient];

      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          this.idleTimers.delete(idleTimer);
        }
        idleTimer = setTimeout(() => {
          if (idleTimer) this.idleTimers.delete(idleTimer);
          first.close(1001, 'idle timeout');
          second.close(1001, 'idle timeout');
        }, this.options.idleTimeoutMs);
        this.idleTimers.add(idleTimer);
      };
      const forward = (from: WsClient, to: WsClient): void => {
        from.on('message', (frame) => {
          const frameBytes = rawToBytes(frame);
          if (frameBytes.length > this.options.maxRelayBytes) {
            from.close(1009, 'relay frame too big');
            to.close(1009, 'relay frame too big');
            return;
          }
          resetIdle();
          to.send(frame);
        });
      };
      forward(first, second);
      forward(second, first);
      first.on('close', () => second.close());
      second.on('close', () => first.close());
      first.once('close', () => {
        if (idleTimer) clearTimeout(idleTimer);
      });
      resetIdle();

      // The controlled peer is a client of this hbbr; its frames are forwarded
      // to the real client. Run the peer script on that client connection.
      if (this.peerClient) void this.runPeer(this.peerClient);
    });
  }

  private async runPeer(peer: WsClient): Promise<void> {
    const frames = new FrameQueue(peer);
    try {
      peer.send(
        encodeMessage({
          signed_id: {
            id: this.signIdPk(
              this.peerId,
              this.peerBoxKeys.publicKey,
              this.peerSignKeys.privateKey,
            ),
          },
        }),
      );

      const publicKey = decodeMessage(await frames.next(5000)).public_key;
      if (!publicKey || publicKey.kx_version !== 0) {
        throw new Error('client sent an invalid PublicKey');
      }
      const secretKey = await openSecret(
        publicKey.symmetric_value,
        publicKey.asymmetric_value,
        this.peerBoxKeys.secretKey,
      );
      if (!secretKey) throw new Error('cannot open the client secretbox key');
      const cipher = await createSecretBoxCipher(secretKey);
      const send = (partial: DeepPartial<message.Message>): void => {
        peer.send(cipher.encrypt(encodeMessage(partial)));
      };

      send({ hash: { salt: this.salt, challenge: this.challenge } });

      for (;;) {
        const msg = decodeMessage(cipher.decrypt(await frames.next(120_000)));
        if (msg.login_request) {
          this.loginRequests.push(msg.login_request);
          if (
            !bytesEqual(
              msg.login_request.password,
              challengeResponse(this.password, this.salt, this.challenge),
            )
          ) {
            send({ login_response: { error: 'Wrong Password' } });
            continue;
          }
          send({ login_response: { peer_info: this.peerInfo } });
          this.loggedIn = true;
          this.peerSend = send;
          if (this.options.sendVideoFrame) {
            this.sendVideo([{ key: true, data: [0, 0, 0, 0, 1, 2, 3, 4] }]);
          }
          continue;
        }
        if (msg.misc?.video_received) {
          this.videoAcks += 1;
          continue;
        }
        if (msg.misc?.refresh_video) {
          this.refreshRequests += 1;
          continue;
        }
        if (msg.misc?.switch_display) {
          this.switchDisplayRequests.push(msg.misc.switch_display);
          continue;
        }
        if (msg.test_delay) continue;
        this.inputs.push(msg);
      }
    } catch (error) {
      this.peerError = error;
    }
  }
}
