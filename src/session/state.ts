/**
 * Session lifecycle states exposed to host apps.
 *
 * The order in the union enumerates the happy path plus the two terminal
 * states; not every connection visits every state (a session with a known
 * password never enters `password-required`).
 */
export type RustDeskStatus =
  /** No connection has been started, or it was disposed. */
  | 'idle'
  /** Opening the rendezvous/relay WebSocket(s). */
  | 'connecting'
  /** Exchanging signed keys and installing the encrypted channel (18s budget). */
  | 'securing'
  /** Hash/LoginRequest exchange with the peer. */
  | 'authenticating'
  /** Login is waiting for the remote user to accept; shown after 3s. */
  | 'awaiting-approval'
  /** The peer rejected the password (or asked for one); `retry` says which. */
  | 'password-required'
  /** `LoginResponse.peer_info` received; video may still be starting. */
  | 'connected'
  /** Session ended cleanly (local disconnect or remote close). */
  | 'disconnected'
  /** Session ended because of a `RustDeskError`. */
  | 'error';

/**
 * Discriminated on `status` so a status-specific payload cannot leak into an
 * unrelated state (e.g. `retry` only exists on `password-required`).
 */
export type RustDeskStatusEvent =
  | {
      status: 'password-required';
      /** Non-secret detail suitable for display (e.g. "Wrong Password"). */
      detail?: string;
      /** True when a previous password was rejected. */
      retry: boolean;
    }
  | {
      status: Exclude<RustDeskStatus, 'password-required'>;
      /** Non-secret detail suitable for display (e.g. the peer's close reason). */
      detail?: string;
    };

/**
 * Statuses in which a connection attempt or session is live.
 *
 * Shared by `RustDeskSession.connect()` (to reject a second concurrent
 * connect) and the viewer (to enable Disconnect); keeping one definition
 * prevents the two from drifting.
 */
const ACTIVE_STATUSES: ReadonlySet<RustDeskStatus> = new Set([
  'connecting',
  'securing',
  'authenticating',
  'awaiting-approval',
  'password-required',
  'connected',
]);

export function isActiveStatus(status: RustDeskStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** Delivery statistics emitted by the session, if the host subscribes. */
export interface SessionStats {
  /** Decoded frames rendered per second. */
  fps: number;
  /** Heartbeat round-trip time in milliseconds. */
  latencyMs: number;
  /** Time spent decoding the last frame in milliseconds. */
  decodeMs: number;
}
