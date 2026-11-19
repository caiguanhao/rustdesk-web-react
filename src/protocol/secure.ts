/**
 * Secure relay handshake (kx_version 0).
 *
 * Sequence, mirroring RustDesk's `secure_connection` and rustdesk-web v1:
 *   1. hbbs signs `IdPk{id, pk}` into `RelayResponse.pk`; verify it with the
 *      configured `serverKey` and require `IdPk.id === peerId`.
 *   2. The peer sends `Message.signed_id`; `SignedId.id` is an Ed25519 signed
 *      `IdPk` carrying the peer's X25519 box public key. Verify it with the
 *      Ed25519 key from step 1 and require the same id and a 32-byte box key.
 *   3. Generate an ephemeral X25519 keypair and a random secretbox key, seal
 *      the latter with `crypto_box_easy` (zero nonce), and send
 *      `PublicKey{asymmetric_value, symmetric_value, kx_version: 0}`.
 *   4. Install the counter secretbox on the socket.
 *
 * Fail-closed by default: any identity/trust failure aborts. With
 * `allowInsecureFallback` the client behaves like v1 instead — sends an empty
 * `PublicKey` and continues in plaintext — and reports the downgrade error.
 * In that case any plaintext `SignedId` already queued stays unread; the
 * caller's login loop must ignore it (v1 does the same).
 *
 * The whole exchange shares one 18 s deadline (the peer waits about that long
 * after `SignedId` for our `PublicKey`). P1-6 should call this only after the
 * relay legs are paired, so pairing delay is not charged to securing.
 */
import type { FrameCipher, WebSock } from './websock.js';
import * as message from './message.js';
import {
  BOX_PUBLIC_KEY_BYTES,
  SIGN_PUBLIC_KEY_BYTES,
  createSecretBoxCipher,
  generateBoxKeyPair,
  generateSecretKey,
  sealSecret,
  verifySigned,
} from '../crypto/handshake.js';
import { RustDeskError, type RustDeskErrorCode } from '../session/errors.js';

export const DEFAULT_SECURING_TIMEOUT_MS = 18_000;

export interface SecureHandshakeOptions {
  /** Requested device id; both signatures must match it. */
  peerId: string;
  /** hbbs Ed25519 public key (base64). Without it the identity is unverifiable. */
  serverKey?: string;
  /** `RelayResponse.pk` (hbbs-signed IdPk). */
  signedIdPk?: Uint8Array;
  /** v1 plaintext fallback when the peer identity cannot be trusted. */
  allowInsecureFallback?: boolean;
  /** Defaults to 18 s. */
  timeoutMs?: number;
}

export type SecureHandshakeResult =
  | { secure: true }
  | { secure: false; error: RustDeskError };

type ServerIdentity = { key: Uint8Array } | { error: RustDeskError };

function handshakeTimeout(timeoutMs: number, cause?: unknown): RustDeskError {
  return new RustDeskError(
    'handshake-timeout',
    `Secure handshake did not complete within ${timeoutMs} ms`,
    { cause },
  );
}

function remainingMs(deadline: number, timeoutMs: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw handshakeTimeout(timeoutMs);
  return remaining;
}

/** Verify `RelayResponse.pk` and return the peer's Ed25519 signing key. */
async function verifyServerIdentity(
  options: SecureHandshakeOptions,
): Promise<ServerIdentity> {
  if (!options.serverKey?.trim()) {
    return {
      error: new RustDeskError(
        'server-key-missing',
        'No serverKey configured; the peer identity cannot be verified',
      ),
    };
  }
  if (!options.signedIdPk || options.signedIdPk.length === 0) {
    return {
      error: new RustDeskError(
        'server-key-missing',
        'The server sent no signed peer identity; refusing an unverifiable peer',
      ),
    };
  }

  let verified: Uint8Array | null;
  try {
    verified = await verifySigned(options.signedIdPk, options.serverKey);
  } catch (cause) {
    // verifySigned throws invalid-config for malformed base64 keys.
    if (cause instanceof RustDeskError && cause.code === 'invalid-config') {
      return {
        error: new RustDeskError(
          'server-key-invalid',
          'The configured serverKey is not valid base64',
          { cause },
        ),
      };
    }
    throw cause;
  }
  if (!verified) {
    return {
      error: new RustDeskError(
        'server-key-invalid',
        'RelayResponse.pk did not verify against the configured serverKey',
      ),
    };
  }

  let idPk: message.IdPk;
  try {
    idPk = message.IdPk.decode(verified);
  } catch (cause) {
    return {
      error: new RustDeskError(
        'server-key-invalid',
        'Signed server identity is not an IdPk',
        { cause },
      ),
    };
  }
  if (idPk.id !== options.peerId) {
    return {
      error: new RustDeskError(
        'peer-id-mismatch',
        'The server-signed identity does not match the requested device id',
      ),
    };
  }
  if (idPk.pk.length !== SIGN_PUBLIC_KEY_BYTES) {
    return {
      error: new RustDeskError(
        'peer-key-invalid',
        `Peer signing key must be ${SIGN_PUBLIC_KEY_BYTES} bytes, got ${idPk.pk.length}`,
      ),
    };
  }
  return { key: idPk.pk };
}

/**
 * Run the secure relay handshake and install the secretbox on `sock`.
 * The caller must not read or write `Message` frames until this resolves.
 */
export async function secureHandshake(
  sock: WebSock,
  options: SecureHandshakeOptions,
): Promise<SecureHandshakeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SECURING_TIMEOUT_MS;
  const allowFallback = options.allowInsecureFallback ?? false;
  const deadline = Date.now() + timeoutMs;

  /** v1 fallback (when allowed) or throw the identity error. */
  const fail = (
    code: RustDeskErrorCode,
    text: string,
    cause?: unknown,
  ): SecureHandshakeResult => {
    const error = new RustDeskError(code, text, { cause });
    if (!allowFallback) throw error;
    // v1 sends an empty PublicKey to tell the peer to continue unencrypted.
    sock.sendMessage({ public_key: {} });
    return { secure: false, error };
  };

  const identity = await verifyServerIdentity(options);
  if ('error' in identity) {
    return fail(identity.error.code, identity.error.message, identity.error.cause);
  }

  let first: message.Message;
  try {
    first = await sock.nextMessage(remainingMs(deadline, timeoutMs));
  } catch (cause) {
    if (cause instanceof RustDeskError && cause.code === 'timeout') {
      throw handshakeTimeout(timeoutMs, cause);
    }
    throw cause;
  }

  const signedId = first.signed_id;
  if (!signedId || signedId.id.length === 0) {
    return fail('peer-signature-invalid', 'Peer did not send a SignedId');
  }

  const verifiedPeer = await verifySigned(signedId.id, identity.key);
  if (!verifiedPeer) {
    return fail(
      'peer-signature-invalid',
      'Peer SignedId did not verify against its signing key',
    );
  }

  let peerIdentity: message.IdPk;
  try {
    peerIdentity = message.IdPk.decode(verifiedPeer);
  } catch (cause) {
    return fail('protocol-error', 'Peer SignedId is not an IdPk', cause);
  }
  if (peerIdentity.id !== options.peerId) {
    return fail('peer-id-mismatch', 'Peer SignedId id does not match the requested device id');
  }
  if (peerIdentity.pk.length !== BOX_PUBLIC_KEY_BYTES) {
    return fail(
      'peer-key-invalid',
      `Peer box key must be ${BOX_PUBLIC_KEY_BYTES} bytes, got ${peerIdentity.pk.length}`,
    );
  }

  const [boxKeys, secretKey] = await Promise.all([
    generateBoxKeyPair(),
    generateSecretKey(),
  ]);
  const symmetricValue = await sealSecret(secretKey, peerIdentity.pk, boxKeys.secretKey);
  // Build the cipher before telling the peer to switch, so a local crypto
  // failure cannot leave the peer encrypted while we stay plaintext.
  const cipher: FrameCipher = await createSecretBoxCipher(secretKey);

  sock.sendMessage({
    public_key: {
      asymmetric_value: boxKeys.publicKey,
      symmetric_value: symmetricValue,
      kx_version: 0,
    },
  });
  sock.setCipher(cipher);
  return { secure: true };
}
