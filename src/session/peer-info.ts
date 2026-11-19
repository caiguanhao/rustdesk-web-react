/**
 * Normalized peer information handed to host apps.
 *
 * Wire messages use RustDesk's snake_case protobuf fields; this public shape
 * is camelCase and contains only what the MVP renders. P1-7 maps the decoded
 * `LoginResponse.peer_info` onto it.
 */

export interface DisplayInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Display name reported by the peer (may be empty). */
  name: string;
  online: boolean;
}

export interface PeerInfo {
  /** Logged-in OS username on the remote machine. */
  username: string;
  hostname: string;
  /** `Windows` | `Linux` | `Mac OS` | `Android` | ... as reported by RustDesk. */
  platform: string;
  displays: DisplayInfo[];
  /** Index into `displays`; the peer captures this display. */
  currentDisplay: number;
  /** Whether the peer requires SAS confirmation. */
  sasEnabled: boolean;
  /** RustDesk version string of the controlled peer. */
  version: string;
  connectionId: number;
  /** Whether the peer is in privacy mode. */
  privacyMode: boolean;
}
