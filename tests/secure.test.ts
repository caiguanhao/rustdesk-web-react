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
import * as message from '../src/protocol/message';
import type { DeepPartial } from '../src/protocol/message';
import {
  secureHandshake,
  type SecureHandshakeOptions,
} from '../src/protocol/secure';
import { WebSock, type WebSocketLike } from '../src/protocol/websock';

// P1-5 acceptance: a mock peer proves the full identity chain and installs a
// secretbox in both directions; every trust failure has a distinct code and
// defaults to fail-closed, with an explicit v1-style plaintext fallback.

const PEER_ID = '123456789';

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

let sodium: Sodium;
let hbbsKeys: { publicKey: Uint8Array; privateKey: Uint8Array };
let peerSignKeys: { publicKey: Uint8Array; privateKey: Uint8Array };
let otherSignKeys: { publicKey: Uint8Array; privateKey: Uint8Array };
let peerBoxKeys: BoxKeyPair;
let SERVER_KEY: string;
let SERVER_SIGNED_ID_PK: Uint8Array;

/** Ed25519-sign `IdPk{id, pk}`; used for both hbbs and peer identities. */
function signIdPk(id: string, pk: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const idPk = message.IdPk.encode(message.IdPk.fromPartial({ id, pk })).finish();
  return sodium.crypto_sign(idPk, privateKey);
}

function validOptions(overrides: Partial<SecureHandshakeOptions> = {}): SecureHandshakeOptions {
  return {
    peerId: PEER_ID,
    serverKey: SERVER_KEY,
    signedIdPk: SERVER_SIGNED_ID_PK,
    ...overrides,
  };
}

beforeAll(async () => {
  sodium = await loadSodium();
  hbbsKeys = sodium.crypto_sign_seed_keypair(seed(0x11));
  peerSignKeys = sodium.crypto_sign_seed_keypair(seed(0x22));
  otherSignKeys = sodium.crypto_sign_seed_keypair(seed(0x33));
  peerBoxKeys = await generateBoxKeyPair();
  SERVER_KEY = Buffer.from(hbbsKeys.publicKey).toString('base64');
  SERVER_SIGNED_ID_PK = signIdPk(PEER_ID, peerSignKeys.publicKey, hbbsKeys.privateKey);
});

interface PeerServer {
  wss: WebSocketServer;
  url: string;
  close: () => Promise<void>;
}

async function startPeer(): Promise<PeerServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    wss,
    url: `ws://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

async function withPeer(
  run: (sock: WebSock, peer: WsClient) => Promise<void>,
): Promise<void> {
  const server = await startPeer();
  const connected = once(server.wss, 'connection');
  const sock = new WebSock(server.url, { createSocket });
  try {
    await sock.open(1000);
    const [peer] = (await connected) as [WsClient];
    await run(sock, peer);
  } finally {
    sock.close();
    await server.close();
  }
}

async function expectHandshakeError(
  sock: WebSock,
  options: SecureHandshakeOptions,
  code: string,
): Promise<void> {
  await expect(secureHandshake(sock, options)).rejects.toMatchObject({ code });
}

describe('secure handshake', () => {
  it('verifies both identities and exchanges encrypted messages', async () => {
    await withPeer(async (sock, peer) => {
      peer.send(
        encodeMessage({
          signed_id: { id: signIdPk(PEER_ID, peerBoxKeys.publicKey, peerSignKeys.privateKey) },
        }),
      );

      const publicKeyFrame = nextFrame(peer);
      const result = await secureHandshake(sock, validOptions());
      expect(result).toEqual({ secure: true });

      const publicKey = decodeMessage(await publicKeyFrame).public_key;
      expect(publicKey).toBeDefined();
      expect(publicKey?.kx_version).toBe(0);
      expect(publicKey?.asymmetric_value).toHaveLength(32);
      expect(publicKey?.symmetric_value).toHaveLength(48);

      const secretKey = await openSecret(
        publicKey!.symmetric_value,
        publicKey!.asymmetric_value,
        peerBoxKeys.secretKey,
      );
      expect(secretKey).toHaveLength(32);
      const peerCipher = await createSecretBoxCipher(secretKey!);

      peer.send(
        peerCipher.encrypt(encodeMessage({ test_delay: { time: 42, from_client: false } })),
      );
      await expect(sock.nextMessage(1000)).resolves.toMatchObject({
        test_delay: { time: 42 },
      });

      const clientFrame = nextFrame(peer);
      sock.sendMessage({ test_delay: { time: 7, from_client: true } });
      const decrypted = peerCipher.decrypt(await clientFrame);
      expect(decodeMessage(decrypted).test_delay?.time).toBe(7);
    });
  });

  it('fails closed when the server identity does not verify', async () => {
    await withPeer(async (sock) => {
      await expectHandshakeError(
        sock,
        validOptions({ serverKey: Buffer.from(otherSignKeys.publicKey).toString('base64') }),
        'server-key-invalid',
      );
    });
  });

  it('fails closed when hbbs provided no signing key or identity', async () => {
    await withPeer(async (sock) => {
      await expectHandshakeError(
        sock,
        validOptions({ signedIdPk: undefined }),
        'server-key-missing',
      );
      await expectHandshakeError(
        sock,
        { peerId: PEER_ID },
        'server-key-missing',
      );
    });
  });

  it('rejects a server-signed identity for another device id', async () => {
    await withPeer(async (sock) => {
      await expectHandshakeError(
        sock,
        validOptions({
          signedIdPk: signIdPk('999999999', peerSignKeys.publicKey, hbbsKeys.privateKey),
        }),
        'peer-id-mismatch',
      );
    });
  });

  it('rejects a wrong-length peer signing key', async () => {
    await withPeer(async (sock) => {
      await expectHandshakeError(
        sock,
        validOptions({
          signedIdPk: signIdPk(PEER_ID, new Uint8Array(31), hbbsKeys.privateKey),
        }),
        'peer-key-invalid',
      );
    });
  });

  it('rejects a peer SignedId signed by the wrong key', async () => {
    await withPeer(async (sock, peer) => {
      peer.send(
        encodeMessage({
          signed_id: {
            id: signIdPk(PEER_ID, peerBoxKeys.publicKey, otherSignKeys.privateKey),
          },
        }),
      );
      await expectHandshakeError(sock, validOptions(), 'peer-signature-invalid');
    });
  });

  it('rejects a peer SignedId for another device id', async () => {
    await withPeer(async (sock, peer) => {
      peer.send(
        encodeMessage({
          signed_id: {
            id: signIdPk('999999999', peerBoxKeys.publicKey, peerSignKeys.privateKey),
          },
        }),
      );
      await expectHandshakeError(sock, validOptions(), 'peer-id-mismatch');
    });
  });

  it('rejects a wrong-length peer box key', async () => {
    await withPeer(async (sock, peer) => {
      peer.send(
        encodeMessage({
          signed_id: { id: signIdPk(PEER_ID, new Uint8Array(31), peerSignKeys.privateKey) },
        }),
      );
      await expectHandshakeError(sock, validOptions(), 'peer-key-invalid');
    });
  });

  it('rejects a first message that is not SignedId', async () => {
    await withPeer(async (sock, peer) => {
      peer.send(encodeMessage({ test_delay: { time: 1, from_client: false } }));
      await expectHandshakeError(sock, validOptions(), 'peer-signature-invalid');
    });
  });

  it('times out the securing phase with handshake-timeout', async () => {
    await withPeer(async (sock) => {
      await expectHandshakeError(
        sock,
        validOptions({ timeoutMs: 30 }),
        'handshake-timeout',
      );
    });
  });

  it('falls back to plaintext only when explicitly allowed', async () => {
    await withPeer(async (sock, peer) => {
      const emptyPublicKey = nextFrame(peer);
      const result = await secureHandshake(sock, {
        peerId: PEER_ID,
        allowInsecureFallback: true,
      });
      expect(result.secure).toBe(false);
      if (!result.secure) expect(result.error.code).toBe('server-key-missing');

      const sent = decodeMessage(await emptyPublicKey);
      expect(sent.public_key).toBeDefined();
      expect(sent.public_key?.asymmetric_value).toHaveLength(0);
      expect(sent.public_key?.symmetric_value).toHaveLength(0);
    });
  });

  it('falls back on a bad peer signature when explicitly allowed', async () => {
    await withPeer(async (sock, peer) => {
      peer.send(
        encodeMessage({
          signed_id: {
            id: signIdPk(PEER_ID, peerBoxKeys.publicKey, otherSignKeys.privateKey),
          },
        }),
      );
      const emptyPublicKey = nextFrame(peer);
      const result = await secureHandshake(sock, validOptions({ allowInsecureFallback: true }));
      expect(result.secure).toBe(false);
      if (!result.secure) expect(result.error.code).toBe('peer-signature-invalid');
      expect(decodeMessage(await emptyPublicKey).public_key).toBeDefined();
    });
  });
});
