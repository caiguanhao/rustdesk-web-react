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

export function isDisplayIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0;
}

/** Clamp a display index to a non-empty display list (falls back to 0). */
export function clampDisplayIndex(index: number, displays: DisplayInfo[]): number {
  return isDisplayIndex(index) && index < displays.length ? index : 0;
}

/**
 * Merge a mid-session `Message.peer_info` sync. The peer sends the display
 * list only and zeroes `current_display` for compatibility, so the local
 * selection is preserved (and clamped if the list shrank).
 */
export function applyDisplayList(peer: PeerInfo, displays: DisplayInfo[]): PeerInfo {
  if (displays.length === 0) return peer;
  return {
    ...peer,
    displays,
    currentDisplay: clampDisplayIndex(peer.currentDisplay, displays),
  };
}
