/**
 * Typed failures surfaced by the session and viewer.
 *
 * Every code is stable API: host apps switch on `error.code` to choose a
 * message/retry policy. Protocol details live in the message, but the message
 * must never contain a password, server key or env-file contents.
 */
export type RustDeskErrorCode =
  /** Missing/invalid config (e.g. no `id`, bad explicit URL). */
  | 'invalid-config'
  /** Caller aborted via `AbortSignal` or disposed the session. */
  | 'aborted'
  /** A WebSocket open or next-message wait exceeded its deadline. */
  | 'timeout'
  /** WebSocket could not open before the timeout. */
  | 'server-unreachable'
  /** hbbs refused the punch-hole/relay request (`refuse_reason`). */
  | 'rendezvous-refused'
  /** Target ID is not registered with hbbs. */
  | 'id-not-found'
  /** Target ID is registered but offline. */
  | 'peer-offline'
  /** Relay response lacks a usable peer/codec version. */
  | 'unsupported-version'
  /** hbbs has no signing key, so the peer identity cannot be verified. */
  | 'server-key-missing'
  /** `RelayResponse.pk` failed Ed25519 verification against `serverKey`. */
  | 'server-key-invalid'
  /** The peer's `SignedId` signature did not verify. */
  | 'peer-signature-invalid'
  /** `IdPk.id` does not match the requested device ID. */
  | 'peer-id-mismatch'
  /** Peer public key has an unexpected length/format. */
  | 'peer-key-invalid'
  /** The 18-second securing phase timed out. */
  | 'handshake-timeout'
  /** No `LoginResponse` within the 60-second login budget. */
  | 'login-timeout'
  /** Remote rejected the password; retry with the same hash challenge. */
  | 'wrong-password'
  /** Remote rate-limited password attempts. */
  | 'too-many-attempts'
  /** Remote asked to try again later (e.g. after too many attempts). */
  | 'try-later'
  /** Remote requires two-factor confirmation. */
  | 'two-factor-required'
  /** Remote blocked this ID/IP. */
  | 'blocked'
  /** Remote revoked keyboard/clipboard permission. */
  | 'no-permission'
  /**
   * The browser clipboard API is unavailable, denied, or the call was not
   * made from a user gesture (expected on iOS for automatic writes).
   */
  | 'clipboard-unavailable'
  /** Peer sent a non-VP9 frame; reconnect so it renegotiates VP9. */
  | 'unsupported-codec'
  /** Peer closed the session (`Misc.close_reason`). */
  | 'peer-closed'
  /** WebSocket closed unexpectedly. */
  | 'connection-lost'
  /** Malformed/unexpected protocol message. */
  | 'protocol-error'
  /** Remote-supplied error string not otherwise classified. */
  | 'peer-error'
  /** A required runtime asset (decoder worker/WASM, crypto library) failed to load. */
  | 'asset-load-failed'
  /** Reverse proxy/server rejected an oversized message (e.g. WebSocket 1009). */
  | 'message-too-large';

export class RustDeskError extends Error {
  // `declare` keeps the field type-only: the constructor assignment below is
  // the only runtime write, so builds targeting ES2020 do not need class-field
  // helpers (nor a second write) for every thrown error.
  declare readonly code: RustDeskErrorCode;

  constructor(code: RustDeskErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RustDeskError';
    this.code = code;
  }
}
