import { once } from 'node:events';
import { beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as WsClient, WebSocketServer, type RawData } from 'ws';
import type { Sodium } from '../src/crypto/sodium';
import { loadSodium } from '../src/crypto/sodium';
import {
  createSecretBoxCipher,
  generateBoxKeyPair,
  openSecret,
  type BoxKeyPair,
} from '../src/crypto/handshake';
import {
  connectRelay,
  type RelayConnection,
  type RendezvousConnectOptions,
} from '../src/protocol/connection';
import * as message from '../src/protocol/message';
import type { DeepPartial } from '../src/protocol/message';
import * as rendezvous from '../src/protocol/rendezvous';
import type { DeepPartial as RendezvousPartial } from '../src/protocol/rendezvous';
import type { RustDeskErrorCode } from '../src/session/errors';
import type { WebSocketLike } from '../src/protocol/websock';

// P1-6 acceptance: a mock hbbs + hbbr pair (hbbr actually pairs two legs and
// forwards frames) runs the whole rendezvous → RequestRelay → secure path,
// plus every refusal/failure mapping, timeouts, cancellation and close_reason.

const PEER_ID = '123456789';
const UUID = '00000000-0000-0000-0000-000000000001';

const createSocket = (url: string): WebSocketLike =>
  new WsClient(url) as unknown as WebSocketLike;

const seed = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

function rawToBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function nextFrame(socket: WsClient): Promise<Uint8Array> {
  return new Promise((resolve) => {
    socket.once('message', (data) => resolve(rawToBytes(data)));
  });
}

const encodeMessage = (partial: DeepPartial<message.Message>): Uint8Array =>
  message.Message.encode(message.Message.fromPartial(partial)).finish();

const decodeMessage = (bytes: Uint8Array): message.Message => message.Message.decode(bytes);

const encodeRendezvous = (partial: RendezvousPartial<rendezvous.RendezvousMessage>): Uint8Array =>
  rendezvous.RendezvousMessage.encode(
    rendezvous.RendezvousMessage.fromPartial(partial),
  ).finish();

let sodium: Sodium;
let hbbsKeys: { publicKey: Uint8Array; privateKey: Uint8Array };
let peerSignKeys: { publicKey: Uint8Array; privateKey: Uint8Array };
let peerBoxKeys: BoxKeyPair;
let SERVER_KEY: string;
let SERVER_SIGNED_ID_PK: Uint8Array;

function signIdPk(id: string, pk: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const idPk = message.IdPk.encode(message.IdPk.fromPartial({ id, pk })).finish();
  return sodium.crypto_sign(idPk, privateKey);
}

beforeAll(async () => {
  sodium = await loadSodium();
  hbbsKeys = sodium.crypto_sign_seed_keypair(seed(0x11));
  peerSignKeys = sodium.crypto_sign_seed_keypair(seed(0x22));
  peerBoxKeys = await generateBoxKeyPair();
  SERVER_KEY = Buffer.from(hbbsKeys.publicKey).toString('base64');
  SERVER_SIGNED_ID_PK = signIdPk(PEER_ID, peerSignKeys.publicKey, hbbsKeys.privateKey);
});

interface HbsServer {
  port: number;
  request: Promise<rendezvous.PunchHoleRequest>;
  close: () => Promise<void>;
}

async function startHbbs(
  respond: (request: rendezvous.PunchHoleRequest, socket: WsClient) => void,
): Promise<HbsServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  if (address.port <= 1024) throw new Error('ephemeral port too low for the +2 rule');

  let resolveRequest!: (request: rendezvous.PunchHoleRequest) => void;
  const request = new Promise<rendezvous.PunchHoleRequest>((resolve) => {
    resolveRequest = resolve;
  });

  wss.on('connection', (socket) => {
    socket.once('message', (data) => {
      let phr: rendezvous.PunchHoleRequest | undefined;
      try {
        phr = rendezvous.RendezvousMessage.decode(rawToBytes(data)).punch_hole_request;
      } catch {
        socket.close(1002, 'bad rendezvous frame');
        return;
      }
      if (!phr) {
        socket.close(1002, 'expected PunchHoleRequest');
        return;
      }
      resolveRequest(phr);
      respond(phr, socket);
    });
  });

  return {
    port: address.port,
    request,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

interface HbrServer {
  url: string;
  port: number;
  paired: Promise<void>;
  requests: Promise<rendezvous.RequestRelay[]>;
  close: () => Promise<void>;
}

/** Minimal hbbr: pair two RequestRelay legs by uuid, then forward frames. */
async function startHbbr(uuid: string): Promise<HbrServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  if (address.port <= 1024) throw new Error('ephemeral port too low for the +2 rule');

  const legs = new Map<string, WsClient[]>();
  const requests: rendezvous.RequestRelay[] = [];
  let resolvePaired!: () => void;
  let resolveRequests!: (requests: rendezvous.RequestRelay[]) => void;
  const paired = new Promise<void>((resolve) => {
    resolvePaired = resolve;
  });
  const requestsDone = new Promise<rendezvous.RequestRelay[]>((resolve) => {
    resolveRequests = resolve;
  });

  wss.on('connection', (socket) => {
    socket.once('message', (data) => {
      let relay: rendezvous.RequestRelay | undefined;
      try {
        relay = rendezvous.RendezvousMessage.decode(rawToBytes(data)).request_relay;
      } catch {
        socket.close(1002, 'bad relay frame');
        return;
      }
      if (!relay || relay.uuid !== uuid) {
        socket.close(1002, 'expected RequestRelay');
        return;
      }
      requests.push(relay);
      if (requests.length === 2) resolveRequests(requests);

      const list = legs.get(relay.uuid) ?? [];
      list.push(socket);
      legs.set(relay.uuid, list);
      if (list.length !== 2) return;

      const [a, b] = list as [WsClient, WsClient];
      resolvePaired();
      a.on('message', (frame) => b.send(frame));
      b.on('message', (frame) => a.send(frame));
      a.on('close', () => b.close());
      b.on('close', () => a.close());
    });
  });

  return {
    url: `ws://127.0.0.1:${address.port}`,
    port: address.port,
    paired,
    requests: requestsDone,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

function connectOptions(
  hbbsPort: number,
  overrides: Partial<RendezvousConnectOptions> = {},
): RendezvousConnectOptions {
  return {
    server: `127.0.0.1:${hbbsPort - 2}`,
    secure: false,
    peerId: PEER_ID,
    serverKey: SERVER_KEY,
    openTimeoutMs: 1000,
    responseTimeoutMs: 1000,
    securingTimeoutMs: 1000,
    createSocket,
    ...overrides,
  };
}

async function connectPeer(url: string, uuid: string): Promise<WsClient> {
  const peer = new WsClient(url);
  await once(peer, 'open');
  peer.send(encodeRendezvous({ request_relay: { uuid, licence_key: SERVER_KEY } }));
  return peer;
}

describe('rendezvous/relay state machine', () => {
  it('runs hbbs → RelayResponse → hbbr pairing → RequestRelay → secure', async () => {
    const hbbr = await startHbbr(UUID);
    const hbbs = await startHbbs((_request, socket) => {
      socket.send(
        encodeRendezvous({
          relay_response: {
            uuid: UUID,
            relay_server: `127.0.0.1:${hbbr.port - 2}`,
            pk: SERVER_SIGNED_ID_PK,
            version: '1.5.3',
          },
        }),
      );
    });

    let peer: WsClient | undefined;
    let connection: RelayConnection | undefined;
    try {
      peer = await connectPeer(hbbr.url, UUID);
      const connecting = connectRelay(connectOptions(hbbs.port));
      await hbbr.paired;

      const publicKeyFrame = nextFrame(peer);
      peer.send(
        encodeMessage({
          signed_id: {
            id: signIdPk(PEER_ID, peerBoxKeys.publicKey, peerSignKeys.privateKey),
          },
        }),
      );

      connection = await connecting;
      expect(connection.secure).toBe(true);
      expect(connection.rendezvousUrl).toBe(`ws://127.0.0.1:${hbbs.port}`);
      expect(connection.relayUrl).toBe(`ws://127.0.0.1:${hbbr.port}`);

      const phr = await hbbs.request;
      expect(phr).toMatchObject({
        id: PEER_ID,
        licence_key: SERVER_KEY,
        nat_type: rendezvous.NatType.SYMMETRIC,
        conn_type: rendezvous.ConnType.DEFAULT_CONN,
      });

      const relayRequests = await hbbr.requests;
      expect(relayRequests).toHaveLength(2);
      for (const request of relayRequests) {
        expect(request.uuid).toBe(UUID);
        expect(request.licence_key).toBe(SERVER_KEY);
      }

      const publicKey = decodeMessage(await publicKeyFrame).public_key;
      expect(publicKey?.kx_version).toBe(0);
      const secretKey = await openSecret(
        publicKey!.symmetric_value,
        publicKey!.asymmetric_value,
        peerBoxKeys.secretKey,
      );
      const peerCipher = await createSecretBoxCipher(secretKey!);

      const clientFrame = nextFrame(peer);
      connection.sendMessage({ test_delay: { time: 99, from_client: false } });
      expect(decodeMessage(peerCipher.decrypt(await clientFrame)).test_delay?.time).toBe(99);

      peer.send(
        peerCipher.encrypt(encodeMessage({ test_delay: { time: 77, from_client: false } })),
      );
      await expect(connection.nextMessage(1000)).resolves.toMatchObject({
        test_delay: { time: 77 },
      });

      peer.send(
        peerCipher.encrypt(encodeMessage({ misc: { close_reason: 'we are done' } })),
      );
      await expect(connection.nextMessage(1000)).rejects.toMatchObject({
        code: 'peer-closed',
        message: 'we are done',
      });
    } finally {
      connection?.close();
      peer?.close();
      await hbbs.close();
      await hbbr.close();
    }
  });

  it.each([
    [{ relay_response: { refuse_reason: 'go away' } }, 'rendezvous-refused'],
    [{ relay_response: { uuid: UUID, version: '' } }, 'unsupported-version'],
    [{ relay_response: { uuid: '', version: '1.5.3' } }, 'protocol-error'],
    [
      { punch_hole_response: { failure: rendezvous.PunchHoleResponse_Failure.ID_NOT_EXIST } },
      'id-not-found',
    ],
    [
      { punch_hole_response: { failure: rendezvous.PunchHoleResponse_Failure.OFFLINE } },
      'peer-offline',
    ],
    [
      {
        punch_hole_response: {
          failure: rendezvous.PunchHoleResponse_Failure.LICENSE_MISMATCH,
        },
      },
      'server-key-invalid',
    ],
    [
      {
        punch_hole_response: {
          failure: rendezvous.PunchHoleResponse_Failure.LICENSE_OVERUSE,
        },
      },
      'rendezvous-refused',
    ],
    [{ punch_hole_response: { other_failure: 'custom refusal' } }, 'rendezvous-refused'],
  ] as [DeepPartial<rendezvous.RendezvousMessage>, RustDeskErrorCode][])(
    'maps %j to %s',
    async (response, code) => {
      const hbbs = await startHbbs((_request, socket) => {
        socket.send(encodeRendezvous(response));
      });
      try {
        await expect(connectRelay(connectOptions(hbbs.port))).rejects.toMatchObject({ code });
      } finally {
        await hbbs.close();
      }
    },
  );

  it('times out waiting for a RelayResponse', async () => {
    const hbbs = await startHbbs(() => {});
    try {
      await expect(
        connectRelay(connectOptions(hbbs.port, { responseTimeoutMs: 30 })),
      ).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      await hbbs.close();
    }
  });

  it('aborts a pending connect and closes the socket', async () => {
    const hbbs = await startHbbs(() => {});
    const controller = new AbortController();
    try {
      const connecting = connectRelay(
        connectOptions(hbbs.port, {
          responseTimeoutMs: 5000,
          signal: controller.signal,
        }),
      );
      setTimeout(() => controller.abort(), 20);
      await expect(connecting).rejects.toMatchObject({ code: 'aborted' });
    } finally {
      await hbbs.close();
    }
  });

  it('rejects an already-aborted signal before connecting', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      connectRelay(
        connectOptions(65000, {
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});
