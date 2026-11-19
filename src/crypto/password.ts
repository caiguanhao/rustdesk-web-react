/**
 * RustDesk login password hashing.
 *
 * The peer sends `Hash{salt, challenge}`. The client must send:
 *   h1   = SHA256(UTF8(password) || UTF8(salt))
 *   wire = SHA256(h1 || UTF8(challenge))
 *
 * This matches v1 `hash([password, salt])` followed by
 * `hash([h1, challenge])`, and RustDesk's server `validate_password_plain`:
 * `Sha256(password.as_bytes()); update(salt.as_bytes())`, then
 * `Sha256(h1); update(challenge.as_bytes())`.
 *
 * fast-sha256 is used (not WebCrypto) so login also works on non-secure
 * origins, which WebCrypto `crypto.subtle` does not expose.
 */
import { Hash } from 'fast-sha256';

const encoder = new TextEncoder();

function sha256Concat(parts: (string | Uint8Array)[]): Uint8Array {
  const hasher = new Hash();
  for (const part of parts) {
    hasher.update(typeof part === 'string' ? encoder.encode(part) : part);
  }
  return hasher.digest();
}

/** `SHA256(UTF8(password) || UTF8(salt))`; keep the result in memory only. */
export function hashPassword(password: string, salt: string): Uint8Array {
  return sha256Concat([password, salt]);
}

/** `SHA256(h1 || UTF8(challenge))`, the bytes sent in `LoginRequest.password`. */
export function challengeResponse(
  password: string,
  salt: string,
  challenge: string,
): Uint8Array {
  return sha256Concat([hashPassword(password, salt), challenge]);
}
