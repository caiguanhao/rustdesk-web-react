/**
 * RustDesk handshake primitives (kx_version 0 / the v1 scheme).
 *
 * - `RelayResponse.pk` and the peer's `SignedId` are Ed25519 signed messages
 *   opened with `crypto_sign_open`.
 * - The controller generates an ephemeral X25519 keypair and a random
 *   32-byte secretbox key, then sends the key sealed with `crypto_box_easy`
 *   (the key exchange version RustDesk uses: single secretbox key, counter
 *   nonces, no BLAKE2b split keys).
 * - Every subsequent `Message` frame is `crypto_secretbox_easy` with a
 *   24-byte little-endian counter nonce; send and receive counters start at
 *   0 and increment before use, so the first nonce is 1.
 *
 * Byte layout matches rustdesk-web v1 `globals.js` and RustDesk's
 * `hbb_common::tcp` (`get_nonce` writes `seqnum.to_le_bytes()`).
 */
import type { FrameCipher } from '../protocol/websock.js';
import { RustDeskError } from '../session/errors.js';
import { loadSodium, type Sodium } from './sodium.js';

/** `crypto_secretbox` nonce size; the first bytes hold the counter. */
export const SECRETBOX_NONCE_BYTES = 24;
export const SECRETBOX_KEY_BYTES = 32;
export const BOX_PUBLIC_KEY_BYTES = 32;
export const BOX_SECRET_KEY_BYTES = 32;
export const SIGN_PUBLIC_KEY_BYTES = 32;

const ZERO_NONCE = new Uint8Array(SECRETBOX_NONCE_BYTES);

export interface BoxKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

function cryptoError(operation: string, cause?: unknown): RustDeskError {
  return new RustDeskError('protocol-error', `Crypto operation failed: ${operation}`, { cause });
}

function decryptError(cause?: unknown): RustDeskError {
  return new RustDeskError(
    'protocol-error',
    'Failed to decrypt Message frame (bad key or tampered data)',
    { cause },
  );
}

function decodeBase64With(sodium: Sodium, value: string): Uint8Array {
  try {
    return sodium.from_base64(value, sodium.base64_variants.ORIGINAL);
  } catch (cause) {
    throw new RustDeskError('invalid-config', 'Invalid base64 key', { cause });
  }
}

function assertLength(name: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new RustDeskError(
      'protocol-error',
      `${name} must be ${expected} bytes, got ${value.length}`,
    );
  }
}

/**
 * Base64-decode an hbbs/peer key. RustDesk uses the original (padded)
 * alphabet; invalid input is a configuration error, not a protocol failure.
 */
export async function decodeBase64(value: string): Promise<Uint8Array> {
  return decodeBase64With(await loadSodium(), value);
}

/**
 * Verify an Ed25519 signed message (`signature || message`).
 *
 * Returns the signed payload, or `null` when the signature does not verify.
 * A wrong-length public key is a caller error and throws.
 */
export async function verifySigned(
  signed: Uint8Array,
  publicKey: Uint8Array | string,
): Promise<Uint8Array | null> {
  const sodium = await loadSodium();
  const key = typeof publicKey === 'string' ? decodeBase64With(sodium, publicKey) : publicKey;
  assertLength('Ed25519 public key', key, SIGN_PUBLIC_KEY_BYTES);
  try {
    const opened = sodium.crypto_sign_open(signed, key);
    return opened instanceof Uint8Array ? opened : null;
  } catch {
    // libsodium throws for a bad signature (and for a signed message shorter
    // than the 64-byte signature). Both mean "this key did not sign this".
    return null;
  }
}

/** Ephemeral X25519 keypair (`crypto_box_keypair`). */
export async function generateBoxKeyPair(): Promise<BoxKeyPair> {
  const sodium = await loadSodium();
  try {
    const pair = sodium.crypto_box_keypair();
    return { publicKey: pair.publicKey, secretKey: pair.privateKey };
  } catch (cause) {
    throw cryptoError('crypto_box_keypair', cause);
  }
}

/** Random 32-byte `crypto_secretbox` key. */
export async function generateSecretKey(): Promise<Uint8Array> {
  const sodium = await loadSodium();
  try {
    return sodium.crypto_secretbox_keygen();
  } catch (cause) {
    throw cryptoError('crypto_secretbox_keygen', cause);
  }
}

/** Seal the secretbox key to the peer with a 24-byte zero nonce. */
export async function sealSecret(
  secretKey: Uint8Array,
  theirPublicKey: Uint8Array,
  ourSecretKey: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await loadSodium();
  assertLength('Secretbox key', secretKey, SECRETBOX_KEY_BYTES);
  assertLength('Peer box public key', theirPublicKey, BOX_PUBLIC_KEY_BYTES);
  assertLength('Our box secret key', ourSecretKey, BOX_SECRET_KEY_BYTES);
  try {
    return sodium.crypto_box_easy(secretKey, ZERO_NONCE, theirPublicKey, ourSecretKey);
  } catch (cause) {
    throw cryptoError('crypto_box_easy', cause);
  }
}

/** Open a box sealed with `sealSecret`; returns `null` on authentication failure. */
export async function openSecret(
  sealed: Uint8Array,
  theirPublicKey: Uint8Array,
  ourSecretKey: Uint8Array,
): Promise<Uint8Array | null> {
  const sodium = await loadSodium();
  assertLength('Peer box public key', theirPublicKey, BOX_PUBLIC_KEY_BYTES);
  assertLength('Our box secret key', ourSecretKey, BOX_SECRET_KEY_BYTES);
  try {
    const opened = sodium.crypto_box_open_easy(sealed, ZERO_NONCE, theirPublicKey, ourSecretKey);
    return opened instanceof Uint8Array ? opened : null;
  } catch {
    return null;
  }
}

/**
 * Little-endian 24-byte nonce: byte 0 is the low byte, matching v1's
 * `makeOnce` and RustDesk's `seqnum.to_le_bytes()`.
 */
function writeCounterNonce(nonce: Uint8Array, sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RustDeskError('protocol-error', `Invalid secretbox counter: ${sequence}`);
  }
  nonce.fill(0);
  let value = sequence;
  for (let index = 0; index < nonce.length && value > 0; index += 1) {
    nonce[index] = value % 256;
    value = Math.floor(value / 256);
  }
}

/** Little-endian counter nonce; exported for tests and handshake diagnostics. */
export function counterNonce(sequence: number): Uint8Array {
  const nonce = new Uint8Array(SECRETBOX_NONCE_BYTES);
  writeCounterNonce(nonce, sequence);
  return nonce;
}

/**
 * Counter-mode secretbox for one direction pair. The returned object can be
 * installed directly with `WebSock.setCipher`.
 *
 * Counters advance only after a successful primitive call, so a crypto error
 * cannot leave the two sides out of step.
 */
export async function createSecretBoxCipher(key: Uint8Array): Promise<FrameCipher> {
  const sodium = await loadSodium();
  assertLength('Secretbox key', key, SECRETBOX_KEY_BYTES);
  let sendSequence = 0;
  let receiveSequence = 0;
  let failed = false;
  // Reused buffers: libsodium copies the nonce synchronously.
  const sendNonce = new Uint8Array(SECRETBOX_NONCE_BYTES);
  const receiveNonce = new Uint8Array(SECRETBOX_NONCE_BYTES);

  const ensureUsable = (): void => {
    if (failed) {
      throw new RustDeskError(
        'protocol-error',
        'Secretbox cipher is unusable after a previous failure; reconnect',
      );
    }
  };

  const encrypt = (plain: Uint8Array): Uint8Array => {
    ensureUsable();
    const sequence = sendSequence + 1;
    writeCounterNonce(sendNonce, sequence);
    try {
      const sealed = sodium.crypto_secretbox_easy(plain, sendNonce, key);
      sendSequence = sequence;
      return sealed;
    } catch (cause) {
      failed = true;
      throw cryptoError('crypto_secretbox_easy', cause);
    }
  };

  const decrypt = (encrypted: Uint8Array): Uint8Array => {
    ensureUsable();
    const sequence = receiveSequence + 1;
    writeCounterNonce(receiveNonce, sequence);
    let opened: Uint8Array | null | false;
    try {
      opened = sodium.crypto_secretbox_open_easy(encrypted, receiveNonce, key);
    } catch (cause) {
      failed = true;
      throw decryptError(cause);
    }
    if (!(opened instanceof Uint8Array)) {
      failed = true;
      throw decryptError();
    }
    receiveSequence = sequence;
    return opened;
  };

  return { encrypt, decrypt };
}
