import { createSocket as createUdpSocket } from 'node:dgram';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import {
  createSecretBoxCipher,
  generateBoxKeyPair,
  openSecret,
} from '../src/crypto/handshake';
import { challengeResponse } from '../src/crypto/password';
import type { Sodium } from '../src/crypto/sodium';
import { loadSodium } from '../src/crypto/sodium';
import { connectRelay, type RelayConnection } from '../src/protocol/connection';
import { LoginFlow } from '../src/protocol/login';
import * as message from '../src/protocol/message';
import type { DeepPartial } from '../src/protocol/message';
import * as rendezvous from '../src/protocol/rendezvous';
import { resolveRelayUrl } from '../src/protocol/url';
import { WebSock, type WebSocketLike } from '../src/protocol/websock';

// P1-9 real-connect test. Opt in with:
//   RD_REAL_SERVER=1 RD_REAL_KEY=<id_ed25519.pub> npm run test -- real-server
// The isolated hbbs/hbbr are started by scripts/dev-server.sh; the controlled
// peer below registers with the real hbbs and drives the real hbbr, proving a
// connection without the user's server or RustDesk client.

interface LocalServerInfo {
  host?: string;
  port?: number;
  serverKey?: string;
}

function readLocalServerInfo(): LocalServerInfo {
  try {
    return JSON.parse(
      readFileSync(resolve(process.cwd(), '.local/rustdesk-server/server.json'), 'utf8'),
    ) as LocalServerInfo;
  } catch {
    return {};
  }
}

const REAL = process.env.RD_REAL_SERVER === '1';
const LOCAL_INFO = REAL ? readLocalServerInfo() : {};
const HOST = process.env.RD_REAL_HOST ?? LOCAL_INFO.host ?? '127.0.0.1';
const PORT = Number(process.env.RD_REAL_PORT ?? LOCAL_INFO.port ?? 12116);
const UDP_PORT = Number(process.env.RD_REAL_UDP_PORT ?? String(PORT));
const SERVER_KEY = process.env.RD_REAL_KEY ?? LOCAL_INFO.serverKey ?? '';
const PEER_ID =
  process.env.RD_REAL_PEER_ID ?? String(100_000_000 + Math.floor(Math.random() * 800_000_000));
const PASSWORD = process.env.RD_REAL_PASSWORD ?? 'real-peer-password';
const RELAY_UUID = `real-relay-${Date.now()}`;

const createSocket = (url: string): WebSocketLike =>
  new WsClient(url) as unknown as WebSocketLike;

const encodeRendezvous = (
  partial: DeepPartial<rendezvous.RendezvousMessage>,
): Uint8Array =>
  rendezvous.RendezvousMessage.encode(
    rendezvous.RendezvousMessage.fromPartial(partial),
  ).finish();

const seed = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

let peerKeys: { publicKey: Uint8Array; privateKey: Uint8Array };
let boxKeys: { publicKey: Uint8Array; secretKey: Uint8Array };
let sodium: Sodium;

const PEER_INFO = message.PeerInfo.fromPartial({
  username: 'real-peer',
  hostname: 'docker-peer',
  platform: 'Linux',
  displays: [{ x: 0, y: 0, width: 1280, height: 720, name: 'Virtual-1', online: true }],
  current_display: 0,
  sas_enabled: false,
  version: '1.5.3',
  conn_id: 7,
  features: { privacy_mode: false },
});

interface UdpPeer {
  send: (partial: DeepPartial<rendezvous.RendezvousMessage>) => void;
  next: (
    predicate: (msg: rendezvous.RendezvousMessage) => boolean,
    timeoutMs: number,
  ) => Promise<rendezvous.RendezvousMessage>;
  close: () => void;
}

async function startUdpPeer(): Promise<UdpPeer> {
  const udp = createUdpSocket('udp4');
  const queue: rendezvous.RendezvousMessage[] = [];
  const waiters: {
    predicate: (msg: rendezvous.RendezvousMessage) => boolean;
    resolve: (msg: rendezvous.RendezvousMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  udp.on('message', (data) => {
    const msg = rendezvous.RendezvousMessage.decode(data);
    const index = waiters.findIndex((waiter) => waiter.predicate(msg));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      if (waiter) clearTimeout(waiter.timer);
      waiter?.resolve(msg);
    } else {
      queue.push(msg);
    }
  });
  udp.bind(0, HOST);
  await once(udp, 'listening');
  return {
    send: (partial) => {
      udp.send(Buffer.from(encodeRendezvous(partial)), UDP_PORT, HOST);
    },
    next: (predicate, timeoutMs) => {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]!);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            const waiterIndex = waiters.indexOf(waiter);
            if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
            reject(new Error('udp rendezvous timeout'));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    close: () => udp.close(),
  };
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

function signIdPk(id: string, pk: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const payload = message.IdPk.encode(message.IdPk.fromPartial({ id, pk })).finish();
  return sodium.crypto_sign(payload, privateKey);
}

describe.skipIf(!REAL)('real hbbs + hbbr connection', () => {
  it('registers a peer, relays, secures and logs in', async () => {
    if (!SERVER_KEY) throw new Error('RD_REAL_KEY (hbbs public key) is required');
    sodium = await loadSodium();
    peerKeys = sodium.crypto_sign_seed_keypair(seed(0x42));
    boxKeys = await generateBoxKeyPair();

    const hbbsUrl = `ws://${HOST}:${PORT + 2}/ws/id`;
    const hbbs = new WebSock(hbbsUrl, {
      createSocket,
      openTimeoutMs: 3000,
      nextTimeoutMs: 5000,
    });
    const udp = await startUdpPeer();
    let relay: WebSock | undefined;
    let connection: RelayConnection | undefined;
    let flow: LoginFlow | undefined;
    try {
      // hbbs accepts RegisterPk only over UDP; RegisterPeerResponse is also UDP.
      udp.send({
        register_pk: {
          id: PEER_ID,
          uuid: Uint8Array.from({ length: 16 }, (_, index) => index + 1),
          pk: peerKeys.publicKey,
        },
      });
      const registerPk = await udp.next((msg) => Boolean(msg.register_pk_response), 3000);
      expect(registerPk.register_pk_response?.result).toBe(
        rendezvous.RegisterPkResponse_Result.OK,
      );

      udp.send({ register_peer: { id: PEER_ID, serial: 1 } });
      const registerPeer = await udp.next(
        (msg) => Boolean(msg.register_peer_response),
        3000,
      );
      expect(registerPeer.register_peer_response?.request_pk).toBe(false);

      const connecting = connectRelay({
        server: `${HOST}:${PORT}`,
        secure: false,
        peerId: PEER_ID,
        serverKey: SERVER_KEY,
        openTimeoutMs: 3000,
        responseTimeoutMs: 5000,
        securingTimeoutMs: 10_000,
        createSocket,
      });

      const punch = (await udp.next((msg) => Boolean(msg.punch_hole), 5000)).punch_hole!;

      // RelayResponse travels over TCP/WS; hbbs signs the registered peer pk
      // and forwards it to the waiting controller.
      await hbbs.open();
      hbbs.sendRendezvous({
        relay_response: {
          socket_addr: punch.socket_addr,
          uuid: RELAY_UUID,
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
      relay = new WebSock(relayUrl, {
        createSocket,
        openTimeoutMs: 3000,
        nextTimeoutMs: 10_000,
      });
      await relay.open();
      relay.sendRendezvous({
        request_relay: { uuid: RELAY_UUID, licence_key: SERVER_KEY, id: PEER_ID },
      });

      relay.sendMessage({
        signed_id: {
          id: signIdPk(PEER_ID, boxKeys.publicKey, peerKeys.privateKey),
        },
      });
      const publicKey = await nextMessageWhere(relay, (msg) => Boolean(msg.public_key), 10_000);
      const secretKey = await openSecret(
        publicKey.public_key!.symmetric_value,
        publicKey.public_key!.asymmetric_value,
        boxKeys.secretKey,
      );
      expect(secretKey).toHaveLength(32);
      const cipher = await createSecretBoxCipher(secretKey!);
      relay.setCipher(cipher);
      relay.sendMessage({ hash: { salt: 'real-salt', challenge: 'real-challenge' } });

      connection = await connecting;
      expect(connection.secure).toBe(true);

      flow = new LoginFlow(connection, {
        peerId: PEER_ID,
        password: PASSWORD,
        loginTimeoutMs: 10_000,
      });
      const infoPromise = flow.start();
      const loginRequest = (
        await nextMessageWhere(relay, (msg) => Boolean(msg.login_request), 10_000)
      ).login_request!;
      expect(loginRequest.username).toBe(PEER_ID);
      expect(Array.from(loginRequest.password)).toEqual(
        Array.from(challengeResponse(PASSWORD, 'real-salt', 'real-challenge')),
      );
      relay.sendMessage({ login_response: { peer_info: PEER_INFO } });

      const info = await infoPromise;
      expect(info).toMatchObject({
        username: 'real-peer',
        hostname: 'docker-peer',
        platform: 'Linux',
        currentDisplay: 0,
        version: '1.5.3',
        connectionId: 7,
      });

      connection.sendMessage({
        mouse_event: { mask: 1, x: 21, y: 22, modifiers: [] },
      });
      connection.sendMessage({
        key_event: { down: true, chr: 65, modifiers: [] },
      });
      const mouse = await nextMessageWhere(relay, (msg) => Boolean(msg.mouse_event), 3000);
      expect(mouse.mouse_event).toMatchObject({x: 21, y: 22});
      const key = await nextMessageWhere(relay, (msg) => Boolean(msg.key_event), 3000);
      expect(key.key_event).toMatchObject({down: true, chr: 65});
    } finally {
      flow?.dispose();
      connection?.close();
      relay?.close();
      hbbs.close();
      udp.close();
    }
  });
});
