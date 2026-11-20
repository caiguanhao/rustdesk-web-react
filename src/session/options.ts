/**
 * Public, framework-agnostic session configuration.
 *
 * The host app is responsible for authorization and for supplying the target
 * peer's credentials. This library never reads global configuration, local
 * storage or environment variables; everything needed to connect arrives here.
 */

/** Requested capture quality. RustDesk maps these onto its image-quality option. */
export type ImageQuality = 'low' | 'balanced' | 'best';

/**
 * Pre-hashed RustDesk password:
 * `base64(SHA256(UTF8(password) || UTF8(salt)))`, i.e. the 32-byte h1.
 *
 * This is a bearer credential for the peer, not an encrypted password. The
 * library never derives plaintext from it; it only computes
 * `SHA256(h1 || challenge)` for the current connection.
 */
export interface RustDeskPasswordHash {
  /** Base64 of the 32-byte h1. */
  hash: string;
  /**
   * Optional. When present it must exactly equal the peer's `Hash.salt`;
   * a mismatch is reported as `password-required` instead of sending a login
   * request with a stale hash.
   */
  salt?: string;
}

/** Accepted by `passwordHash`: a bare base64 h1 or the object form. */
export type RustDeskPasswordHashInput = string | RustDeskPasswordHash;

/**
 * Accepted by login/connect/onPasswordRequired. A bare string is **plaintext**;
 * only the object form is a pre-hashed h1.
 */
export type RustDeskPasswordCredential = string | RustDeskPasswordHash;

/**
 * Resolves the hbbs public key at connect time (e.g. from an authenticated
 * API). Return `undefined`/an empty string to fall through to
 * `serverKeyVerifier`/`serverKey`; throw to fail the connect.
 */
export type RustDeskServerKeyProvider = () =>
  | string
  | undefined
  | Promise<string | undefined>;

/**
 * A signed server-key envelope, compatible with the RustDesk web client's
 * license verifier slot: `verifier` is `signature || message`, and the message
 * is either `1000::<serverKey>` or the raw base64 key.
 *
 * This is a signed encoding, not encryption: anyone who has the verifier can
 * recover the serverKey. It keeps the key out of static bundles and lets an
 * authenticated API gate delivery, but it does not hide the key from the
 * browser user.
 */
export interface RustDeskServerKeyVerifier {
  /**
   * Base64 Ed25519 public key that signed `verifier`. The signature only adds
   * trust if this key is pinned/trusted out-of-band.
   */
  publicKey: string;
  /** Base64 of `signature || message`; the message is plaintext. */
  verifier: string;
}

export interface RustDeskSessionConfig {
  /**
   * hbbs host as `host` or `host:port`. On an HTTPS page without an explicit
   * port this becomes `wss://<host>/ws/id`; with a port the port is shifted by
   * +2 (e.g. `host:21116` → `wss://host:21118`). See P1-2.
   */
  server: string;
  /**
   * hbbs Ed25519 public key (base64) used to verify the server-signed peer
   * identity. Required for self-hosted servers; the library fails closed when
   * the server cannot prove its identity.
   *
   * This is the static fallback. `serverKeyProvider` (per-connect fetch) and
   * `serverKeyVerifier` (signed envelope) take precedence; see their docs.
   */
  serverKey?: string;
  /**
   * Resolve the server key at the start of every `connect()`, before any
   * WebSocket opens. A non-empty result wins; empty/undefined falls through to
   * `serverKeyVerifier` and then `serverKey`. Errors fail the connect closed.
   *
   * The function is called by the session, never during render. React hosts may
   * pass an inline function (the hook reads the latest prop via a ref); direct
   * `RustDeskSession` hosts should pass a stable function.
   */
  serverKeyProvider?: RustDeskServerKeyProvider;
  /**
   * Signed server-key envelope, checked before connecting. Takes precedence
   * over static `serverKey` unless `serverKeyProvider` returns a non-empty
   * value. Invalid envelope/key => `server-key-invalid` (no fallback).
   *
   * The payload is plaintext (`1000::<serverKey>` or the raw key); see
   * `RustDeskServerKeyVerifier` for the security caveat.
   */
  serverKeyVerifier?: RustDeskServerKeyVerifier;
  /** Remote device ID to control. */
  id: string;
  /**
   * Remote device password. Kept in memory only and never persisted by the
   * library. Omit it to let the viewer prompt (or answer `onPasswordRequired`).
   *
   * Mutually exclusive with a non-empty `passwordHash`.
   */
  password?: string;
  /**
   * Pre-hashed password (RustDesk h1), so the browser never needs the
   * plaintext. Accepts a bare base64 h1 or `{ hash, salt? }`. Mutually
   * exclusive with a non-empty `password`.
   */
  passwordHash?: RustDeskPasswordHashInput;
  /** Optional relay host override; normally taken from `RelayResponse`. */
  relayServer?: string;
  /** Explicit rendezvous WebSocket URL (tests, non-standard reverse proxies). */
  rendezvousUrl?: string;
  /** Explicit relay WebSocket URL (tests, non-standard reverse proxies). */
  relayUrl?: string;
  /** Location of the ogv.js VP9 assets copied by `copy-assets`. Same-origin. */
  assetBaseUrl?: string;
  /**
   * Force the SIMD or non-SIMD VP9 decoder; omit to feature-detect (with the
   * mandatory non-SIMD fallback). Diagnostics only: lets a newer phone verify
   * the iOS 15/16.3 no-SIMD path (e.g. the demo's `?simd=0`).
   */
  decoderSimd?: boolean;
  /** Capture quality hint; defaults to `balanced`. */
  imageQuality?: ImageQuality;
  /**
   * View-only mode (P3-6): do not send mouse/keyboard/touch/clipboard input
   * and do not apply the remote clipboard locally. Hosts should also hide or
   * disable input controls when this is set.
   */
  readOnly?: boolean;
  /** Disable clipboard sync in both directions (mouse/keyboard stay on). */
  disableClipboard?: boolean;
  /**
   * When true, a peer that cannot complete the signed handshake falls back to
   * an unencrypted session (v1 behaviour). Defaults to false (fail closed).
   */
  allowInsecureFallback?: boolean;
  /**
   * Send the official web client's `version`/`my_platform` fields. Defaults to
   * false to mirror v1's minimal login request and avoid enabling newer peer
   * behaviours such as multi-clipboard.
   */
  advertiseWebClientVersion?: boolean;
}
