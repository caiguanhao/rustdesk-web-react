/**
 * RustDesk password credential normalization.
 *
 * Two forms are accepted by the public API:
 * - plaintext: a non-empty string (the existing behaviour);
 * - pre-hashed: the 32-byte h1 = SHA256(UTF8(password) || UTF8(salt)),
 *   supplied as base64 or as `{ hash, salt? }`.
 *
 * The h1 is never decrypted or sent as-is. It is only used to compute
 * `SHA256(h1 || challenge)` for the current peer challenge.
 */
import { RustDeskError } from './errors.js';
import type {
  RustDeskPasswordCredential,
  RustDeskPasswordHash,
  RustDeskPasswordHashInput,
  RustDeskSessionConfig,
} from './options.js';

/** Length of the RustDesk h1 digest. */
export const PASSWORD_HASH_BYTES = 32;

/** Non-secret detail emitted when a hash was derived from another salt. */
export const PASSWORD_SALT_MISMATCH_DETAIL = 'Password hash salt mismatch';

export type NormalizedPasswordCredential =
  | { kind: 'plaintext'; password: string }
  | { kind: 'hash'; h1: Uint8Array; salt?: string };

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_BASE64_LENGTH = 64;

function invalidCredential(message: string, cause?: unknown): RustDeskError {
  return new RustDeskError(
    'invalid-config',
    message,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Decode a base64 h1. Accepts the standard alphabet with optional padding;
 * rejects base64url and anything that is not exactly 32 bytes. `atob` (not
 * libsodium) keeps this path synchronous and independent of the crypto
 * runtime. The value is never included in the error message.
 */
export function decodePasswordHash(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidCredential('Password hash must be a non-empty base64 string');
  }
  if (value.length > MAX_BASE64_LENGTH || !BASE64_RE.test(value)) {
    throw invalidCredential('Password hash must use the standard base64 alphabet');
  }
  if (value.length % 4 === 1) {
    throw invalidCredential('Password hash has an invalid base64 length');
  }

  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    if (typeof atob !== 'function') {
      throw new Error('atob is unavailable');
    }
    binary = atob(padded);
  } catch (cause) {
    throw invalidCredential('Password hash is not valid base64', cause);
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (bytes.length !== PASSWORD_HASH_BYTES) {
    throw invalidCredential(
      `Password hash must decode to ${PASSWORD_HASH_BYTES} bytes`,
    );
  }
  return bytes;
}

/** Shared validation/decoding for `passwordHash` and hash credentials. */
function normalizeHashCredential(
  input: RustDeskPasswordHashInput,
): NormalizedPasswordCredential {
  if (typeof input === 'string') {
    return { kind: 'hash', h1: decodePasswordHash(input) };
  }
  if (input === null || input === undefined || typeof input !== 'object') {
    throw invalidCredential('Password hash must be a base64 string or { hash }');
  }
  const { hash, salt } = input as RustDeskPasswordHash;
  if (typeof hash !== 'string') {
    throw invalidCredential('Password hash must be a base64 string');
  }
  if (salt !== undefined && typeof salt !== 'string') {
    throw invalidCredential('Password hash salt must be a string');
  }
  return {
    kind: 'hash',
    h1: decodePasswordHash(hash),
    ...(salt === undefined ? {} : { salt }),
  };
}

/**
 * Normalize a credential coming from login/connect/onPasswordRequired.
 * A bare string is always plaintext; only the object form is a hash.
 */
export function normalizePasswordCredential(
  credential: RustDeskPasswordCredential | null | undefined,
): NormalizedPasswordCredential | undefined {
  if (credential === undefined || credential === null) return undefined;
  if (typeof credential === 'string') {
    return credential.length === 0
      ? undefined
      : { kind: 'plaintext', password: credential };
  }
  if (typeof credential !== 'object') {
    throw invalidCredential('Password credential must be a string or { hash }');
  }
  return normalizeHashCredential(credential);
}

/**
 * Resolve the configured initial credential to its normalized form.
 *
 * `password` and `passwordHash` are mutually exclusive when both are
 * non-empty. A bare `passwordHash` string is a hash (not plaintext); a bare
 * string returned from `onPasswordRequired` is plaintext.
 */
export function resolveConfiguredPassword(
  config: Pick<RustDeskSessionConfig, 'password' | 'passwordHash'>,
): NormalizedPasswordCredential | undefined {
  if (typeof config.password === 'string' && config.password.length > 0) {
    if (config.passwordHash !== undefined) {
      throw invalidCredential(
        'password and passwordHash are mutually exclusive',
      );
    }
    return { kind: 'plaintext', password: config.password };
  }
  if (config.passwordHash !== undefined) {
    return normalizeHashCredential(config.passwordHash);
  }
  return undefined;
}
