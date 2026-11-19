/**
 * Public, framework-agnostic session configuration.
 *
 * The host app is responsible for authorization and for supplying the target
 * peer's credentials. This library never reads global configuration, local
 * storage or environment variables; everything needed to connect arrives here.
 */

/** Requested capture quality. RustDesk maps these onto its image-quality option. */
export type ImageQuality = 'low' | 'balanced' | 'best';

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
   */
  serverKey?: string;
  /** Remote device ID to control. */
  id: string;
  /**
   * Remote device password. Kept in memory only and never persisted by the
   * library. Omit it to let the viewer prompt (or answer `onPasswordRequired`).
   */
  password?: string;
  /** Optional relay host override; normally taken from `RelayResponse`. */
  relayServer?: string;
  /** Explicit rendezvous WebSocket URL (tests, non-standard reverse proxies). */
  rendezvousUrl?: string;
  /** Explicit relay WebSocket URL (tests, non-standard reverse proxies). */
  relayUrl?: string;
  /** Location of the ogv.js VP9 assets copied by `copy-assets`. Same-origin. */
  assetBaseUrl?: string;
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
