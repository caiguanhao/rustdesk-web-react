/**
 * Long-running isolated controlled peer for the local Docker hbbs/hbbr.
 *
 * Registers over UDP (RustDesk peers do this; hbbs rejects RegisterPk over
 * TCP/WS), waits for PunchHole, sends RelayResponse to hbbs, joins hbbr with
 * RequestRelay, then performs SignedId/PublicKey/Hash/Login and logs input.
 * Prints the peer ID and password the demo form should use.
 *
 * Usage:
 *   npm run dev:server
 *   npm run dev:peer
 * Then open the demo, enter 127.0.0.1:12116 and the printed values.
 *
 * Env: RD_REAL_HOST, RD_REAL_PORT, RD_REAL_UDP_PORT, RD_REAL_KEY,
 *      RD_REAL_PEER_ID, RD_REAL_PASSWORD.
 */
import { createSocket as createUdpSocket } from 'node:dgram';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocket as WsClient } from 'ws';
import {
  createSecretBoxCipher,
  generateBoxKeyPair,
  openSecret,
  type BoxKeyPair,
} from '../src/crypto/handshake';
import { challengeResponse } from '../src/crypto/password';
import type { Sodium } from '../src/crypto/sodium';
import { loadSodium } from '../src/crypto/sodium';
import * as message from '../src/protocol/message';
import type { DeepPartial } from '../src/protocol/message';
import * as rendezvous from '../src/protocol/rendezvous';
import { resolveRelayUrl } from '../src/protocol/url';
import { WebSock, type WebSocketLike } from '../src/protocol/websock';

const HOST = process.env.RD_REAL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.RD_REAL_PORT ?? '12116');
const UDP_PORT = Number(process.env.RD_REAL_UDP_PORT ?? String(PORT));
const PEER_ID =
  process.env.RD_REAL_PEER_ID ?? String(100_000_000 + Math.floor(Math.random() * 800_000_000));
const PASSWORD =
  process.env.RD_REAL_PASSWORD ?? `demo-${Math.floor(100_000 + Math.random() * 800_000)}`;

const createSocket = (url: string): WebSocketLike =>
  new WsClient(url) as unknown as WebSocketLike;

const encodeRendezvous = (
  partial: DeepPartial<rendezvous.RendezvousMessage>,
): Uint8Array =>
  rendezvous.RendezvousMessage.encode(
    rendezvous.RendezvousMessage.fromPartial(partial),
  ).finish();

function loadServerKey(): string {
  if (process.env.RD_REAL_KEY) return process.env.RD_REAL_KEY;
  const file = resolve(process.cwd(), '.local/rustdesk-server/server.json');
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as { serverKey?: string };
    if (info.serverKey) return info.serverKey;
  } catch {
    // fall through
  }
  throw new Error('RD_REAL_KEY is required (or run npm run dev:server first)');
}

const SERVER_KEY = loadServerKey();
const PEER_INFO = message.PeerInfo.fromPartial({
  username: 'docker-peer',
  hostname: 'mock-desktop',
  platform: 'Linux',
  displays: [{ x: 0, y: 0, width: 1920, height: 1080, name: 'Virtual-1', online: true }],
  current_display: 0,
  sas_enabled: false,
  version: '1.5.3',
  conn_id: 1,
  features: { privacy_mode: false },
});

let sodium: Sodium;
let signKeys: { publicKey: Uint8Array; privateKey: Uint8Array };
let boxKeys: BoxKeyPair;

class UdpRendezvous {
  private readonly socket = createUdpSocket('udp4');
  private readonly queue: rendezvous.RendezvousMessage[] = [];
  private readonly waiters: {
    predicate: (msg: rendezvous.RendezvousMessage) => boolean;
    resolve: (msg: rendezvous.RendezvousMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  async start(): Promise<void> {
    this.socket.on('message', (data) => {
      const msg = rendezvous.RendezvousMessage.decode(data);
      const index = this.waiters.findIndex((waiter) => waiter.predicate(msg));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        if (waiter) clearTimeout(waiter.timer);
        waiter?.resolve(msg);
      } else if (msg.punch_hole && this.queue.length < 8) {
        // Keep only actionable punches; periodic register responses are noise.
        this.queue.push(msg);
      }
    });
    this.socket.bind(0, HOST);
    await once(this.socket, 'listening');
  }

  send(partial: DeepPartial<rendezvous.RendezvousMessage>): void {
    this.socket.send(Buffer.from(encodeRendezvous(partial)), UDP_PORT, HOST);
  }

  next(
    predicate: (msg: rendezvous.RendezvousMessage) => boolean,
    timeoutMs = 60_000,
  ): Promise<rendezvous.RendezvousMessage> {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]!);
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: resolvePromise,
        timer: setTimeout(() => {
          const waiterIndex = this.waiters.indexOf(waiter);
          if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
          reject(new Error('udp rendezvous timeout'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

function signIdPk(id: string, pk: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const payload = message.IdPk.encode(message.IdPk.fromPartial({ id, pk })).finish();
  return sodium.crypto_sign(payload, privateKey);
}

async function nextMessageWhere(
  sock: WebSock,
  predicate: (msg: message.Message) => boolean,
  timeoutMs: number,
): Promise<message.Message> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('relay message timeout');
    const msg = await sock.nextMessage(remaining);
    if (predicate(msg)) return msg;
  }
}

async function serveRelay(relayUrl: string, uuid: string): Promise<void> {
  const relay = new WebSock(relayUrl, {
    createSocket,
    openTimeoutMs: 5000,
    nextTimeoutMs: 30_000,
  });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    await relay.open();
    relay.sendRendezvous({
      request_relay: { uuid, licence_key: SERVER_KEY, id: PEER_ID },
    });
    relay.sendMessage({
      signed_id: {
        id: signIdPk(PEER_ID, boxKeys.publicKey, signKeys.privateKey),
      },
    });

    const publicKey = await nextMessageWhere(relay, (msg) => Boolean(msg.public_key), 15_000);
    const secretKey = await openSecret(
      publicKey.public_key!.symmetric_value,
      publicKey.public_key!.asymmetric_value,
      boxKeys.secretKey,
    );
    if (!secretKey) throw new Error('cannot open the client secretbox key');
    relay.setCipher(await createSecretBoxCipher(secretKey));
    relay.sendMessage({ hash: { salt: 'demo-salt', challenge: 'demo-challenge' } });

    let lastMouseLog = 0;
    for (;;) {
      const msg = await relay.nextMessage(120_000);
      if (msg.login_request) {
        if (
          !Buffer.from(msg.login_request.password).equals(
            Buffer.from(challengeResponse(PASSWORD, 'demo-salt', 'demo-challenge')),
          )
        ) {
          relay.sendMessage({ login_response: { error: 'Wrong Password' } });
          console.log('login rejected: wrong password');
          continue;
        }
        relay.sendMessage({ login_response: { peer_info: PEER_INFO } });
        relay.sendMessage({
          misc: {
            permission_info: {
              permission: message.PermissionInfo_Permission.Keyboard,
              enabled: true,
            },
          },
        });
        relay.sendMessage({
          misc: {
            permission_info: {
              permission: message.PermissionInfo_Permission.Clipboard,
              enabled: true,
            },
          },
        });
        console.log(`CONNECTED controller=${relay.url}`);
        if (!heartbeat) {
          heartbeat = setInterval(() => {
            try {
              relay.sendMessage({ test_delay: { time: Date.now(), from_client: false } });
            } catch {
              // closed
            }
          }, 10_000);
        }
        continue;
      }
      if (msg.test_delay) continue;
      if (msg.mouse_event) {
        const now = Date.now();
        if ((msg.mouse_event.mask & 7) === 0 && now - lastMouseLog < 200) continue;
        lastMouseLog = now;
        console.log('mouse', JSON.stringify(msg.mouse_event));
      } else if (msg.key_event) {
        console.log('key', JSON.stringify(msg.key_event));
      } else if (msg.clipboard) {
        console.log('clipboard', new TextDecoder().decode(msg.clipboard.content));
      } else {
        console.log('message', JSON.stringify(message.Message.toJSON(msg)));
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    relay.close();
  }
}

async function main(): Promise<void> {
  sodium = await loadSodium();
  signKeys = sodium.crypto_sign_seed_keypair(
    Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 0x42) & 0xff),
  );
  boxKeys = await generateBoxKeyPair();

  const udp = new UdpRendezvous();
  await udp.start();
  const uuid = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  udp.send({ register_pk: { id: PEER_ID, uuid, pk: signKeys.publicKey } });
  const pkResponse = await udp.next((msg) => Boolean(msg.register_pk_response), 5000);
  if (pkResponse.register_pk_response?.result !== rendezvous.RegisterPkResponse_Result.OK) {
    throw new Error(`register_pk failed: ${pkResponse.register_pk_response?.result}`);
  }
  udp.send({ register_peer: { id: PEER_ID, serial: 1 } });
  await udp.next((msg) => Boolean(msg.register_peer_response), 5000);

  setInterval(() => {
    try {
      udp.send({ register_peer: { id: PEER_ID, serial: 1 } });
    } catch {
      // closed
    }
  }, 5000).unref();

  // The generated demo password is local-only; keep it out of stdout/logs.
  const infoDir = resolve(process.cwd(), '.local/rustdesk-server');
  mkdirSync(infoDir, { recursive: true });
  const infoFile = resolve(infoDir, 'peer.json');
  writeFileSync(
    infoFile,
    `${JSON.stringify(
      { id: PEER_ID, password: PASSWORD, server: `${HOST}:${PORT}`, serverKey: SERVER_KEY },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  console.log('');
  console.log('=== controlled peer ready ===');
  console.log(`id:      ${PEER_ID}`);
  console.log(`server:  ${HOST}:${PORT}`);
  console.log(`key:     ${SERVER_KEY}`);
  console.log(`password written to ${infoFile} (mode 0600, gitignored)`);
  console.log('');

  for (;;) {
    const punch = (await udp.next((msg) => Boolean(msg.punch_hole))).punch_hole;
    if (!punch) continue;
    const relayUuid = `demo-relay-${Date.now()}`;
    const hbbs = new WebSock(`ws://${HOST}:${PORT + 2}/ws/id`, {
      createSocket,
      openTimeoutMs: 5000,
    });
    try {
      await hbbs.open();
      hbbs.sendRendezvous({
        relay_response: {
          socket_addr: punch.socket_addr,
          uuid: relayUuid,
          relay_server: punch.relay_server,
          id: PEER_ID,
          version: '1.5.3',
        },
      });
      const relayUrl = resolveRelayUrl({
        server: `${HOST}:${PORT}`,
        relayServer: punch.relay_server,
        secure: false,
      });
      console.log(`punch from controller; relaying via ${relayUrl}`);
      await serveRelay(relayUrl, relayUuid).catch((error: unknown) => {
        console.log('session ended:', error instanceof Error ? error.message : error);
      });
    } finally {
      hbbs.close();
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
