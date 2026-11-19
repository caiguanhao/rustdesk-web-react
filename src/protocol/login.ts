/**
 * Relay login + pre-session message handling.
 *
 * Sequence (RustDesk server `handle_login_request`):
 *   1. The peer sends `Hash{salt, challenge}`.
 *   2. We send `LoginRequest{username: peerId, my_id: "web", my_name: "web",
 *      password: SHA256(SHA256(UTF8(password)||salt)||challenge),
 *      option, video_ack_required: true}`. No `supported_decoding` (forces
 *      VP9), no version/my_platform/session_id unless `advertiseWebClientVersion`.
 *   3. `LoginResponse.error` is mapped to typed errors. `Wrong Password` keeps
 *      the connection and the same Hash so the caller can retry via `login()`;
 *      `No Password Access` means the remote user must accept, so we keep
 *      waiting.
 *   4. `LoginResponse.peer_info` resolves with the normalized `PeerInfo`.
 *
 * During login this flow echoes `TestDelay{from_client:false}`, sends a
 * 10–15 s heartbeat, reports `permission_info`, and acknowledges early video
 * frames (the peer gates encoding on acks). Non-login messages are preserved
 * for the video/input layers (`takePendingMessages`).
 */
import * as message from './message.js';
import type { RelayConnection } from './connection.js';
import { challengeResponse } from '../crypto/password.js';
import { RustDeskError } from '../session/errors.js';
import type { ImageQuality } from '../session/options.js';
import { clampDisplayIndex, type PeerInfo } from '../session/peer-info.js';
import {
  permissionNameFromWire,
  type PermissionChange,
} from '../session/permissions.js';
import type { RustDeskStatusEvent } from '../session/state.js';

export const DEFAULT_LOGIN_TIMEOUT_MS = 60_000;
export const DEFAULT_APPROVAL_AFTER_MS = 3_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 12_000;

/** Official web client version, only sent when `advertiseWebClientVersion` is on. */
export const WEB_CLIENT_VERSION = '1.3.7';

/** Structural subset of P1-6's RelayConnection (easy to fake in tests). */
export type LoginChannel = Pick<RelayConnection, 'sendMessage' | 'nextMessage'>;

export interface LoginFlowOptions {
  peerId: string;
  /** Initial password; omit to be told through the `password-required` status. */
  password?: string;
  imageQuality?: ImageQuality;
  /** Send the official 1.3.7 version/my_platform fields (default false). */
  advertiseWebClientVersion?: boolean;
  /** Total login budget, default 60 s. */
  loginTimeoutMs?: number;
  /** Emit `awaiting-approval` after this long, default 3 s. */
  approvalAfterMs?: number;
  /** TestDelay heartbeat interval, default 12 s (spec: 10–15 s). */
  heartbeatIntervalMs?: number;
  onStatus?: (event: RustDeskStatusEvent) => void;
  onPermission?: (change: PermissionChange) => void;
}

const IMAGE_QUALITY: Record<ImageQuality, message.ImageQuality> = {
  low: message.ImageQuality.Low,
  balanced: message.ImageQuality.Balanced,
  best: message.ImageQuality.Best,
};

/** Map RustDesk's login error strings to stable public error codes. */
export function mapLoginError(text: string): RustDeskError {
  switch (text) {
    case 'Wrong Password':
    case 'Empty Password':
      return new RustDeskError('wrong-password', text);
    case 'Wrong 2FA Code':
    case '2FA Required':
      return new RustDeskError('two-factor-required', text);
    case 'Too many wrong attempts':
      return new RustDeskError('too-many-attempts', text);
    case 'Please try 1 minute later':
      return new RustDeskError('try-later', text);
    case 'Offline':
      return new RustDeskError('peer-offline', text);
    default:
      if (text.includes('blocked')) return new RustDeskError('blocked', text);
      if (text.includes('No permission')) return new RustDeskError('no-permission', text);
      return new RustDeskError('peer-error', text);
  }
}

/** Normalize the wire PeerInfo (snake_case) for the public API. */
export function mapPeerInfo(info: message.PeerInfo): PeerInfo {
  return {
    username: info.username,
    hostname: info.hostname,
    platform: info.platform,
    // Wire and public DisplayInfo shapes are identical.
    displays: info.displays,
    currentDisplay: clampDisplayIndex(info.current_display, info.displays),
    sasEnabled: info.sas_enabled,
    version: info.version,
    connectionId: info.conn_id,
    privacyMode: info.features?.privacy_mode ?? false,
  };
}

function loginTimeoutError(timeoutMs: number, cause?: unknown): RustDeskError {
  return new RustDeskError(
    'login-timeout',
    `Login did not complete within ${timeoutMs} ms`,
    { cause },
  );
}

export class LoginFlow {
  private readonly options: LoginFlowOptions;
  private readonly channel: LoginChannel;
  private readonly pending: message.Message[] = [];
  private hash: message.Hash | undefined;
  private initialPassword: string | undefined;
  private started = false;
  private settled = false;
  private approvalTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(channel: LoginChannel, options: LoginFlowOptions) {
    this.channel = channel;
    this.options = options;
  }

  /**
   * Begin waiting for Hash and login responses. Resolves only with peer_info;
   * if no password is supplied, emits `password-required` and stays pending
   * until `login(password)` is called.
   */
  start(password: string | undefined = this.options.password, signal?: AbortSignal): Promise<PeerInfo> {
    if (this.started) throw new RustDeskError('protocol-error', 'Login already started');
    if (this.settled) throw new RustDeskError('aborted', 'Login flow is closed');
    this.started = true;
    if (password) this.initialPassword = password;

    const timeoutMs = this.options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeat(),
      this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    this.emitStatus({ status: 'authenticating' });
    return this.run(timeoutMs, deadline, signal);
  }

  /**
   * Retry the login with a new password using the already received Hash.
   * Call only after a `password-required` status.
   */
  login(password: string): void {
    if (this.settled) throw new RustDeskError('aborted', 'Login flow is closed');
    if (!password) {
      this.emitPasswordRequired(false, 'Password required');
      return;
    }
    this.sendLogin(password);
  }

  /** Messages received during login that other layers must still process. */
  takePendingMessages(): message.Message[] {
    return this.pending.splice(0);
  }

  /** Stop timers; the caller owns closing the channel. */
  dispose(): void {
    this.settled = true;
    this.cleanup();
  }

  private async run(
    timeoutMs: number,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<PeerInfo> {
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw loginTimeoutError(timeoutMs);
        const msg = await this.channel.nextMessage(remaining, signal);
        const peerInfo = this.handle(msg);
        if (peerInfo) {
          this.settled = true;
          this.emitStatus({ status: 'connected' });
          return peerInfo;
        }
      }
    } catch (error) {
      this.settled = true;
      if (error instanceof RustDeskError && error.code === 'timeout') {
        throw loginTimeoutError(timeoutMs, error);
      }
      throw error;
    } finally {
      this.cleanup();
      this.initialPassword = undefined;
    }
  }

  /** Returns PeerInfo once login succeeds; throws for fatal login errors. */
  private handle(msg: message.Message): PeerInfo | undefined {
    if (msg.misc?.close_reason) {
      throw new RustDeskError('peer-closed', msg.misc.close_reason);
    }
    if (msg.hash) {
      this.hash = msg.hash;
      if (this.initialPassword) {
        const password = this.initialPassword;
        this.initialPassword = undefined;
        this.sendLogin(password);
      } else {
        this.emitPasswordRequired(false);
      }
      return;
    }
    if (msg.test_delay) {
      if (!msg.test_delay.from_client) this.channel.sendMessage({ test_delay: msg.test_delay });
      return;
    }
    if (msg.login_response) return this.handleLoginResponse(msg.login_response);
    if (msg.misc?.permission_info) {
      this.handlePermission(msg.misc.permission_info);
      return;
    }
    if (msg.video_frame) {
      // The peer gates encoding on video_received acks; ack even pre-login.
      this.channel.sendMessage({ misc: { video_received: true } });
      this.pending.push(msg);
      return;
    }
    this.pending.push(msg);
  }

  private handleLoginResponse(response: message.LoginResponse): PeerInfo | undefined {
    const error = response.error;
    if (error === 'Wrong Password') {
      this.clearApprovalTimer();
      this.emitPasswordRequired(true, error);
      return;
    }
    if (error === 'Empty Password') {
      this.clearApprovalTimer();
      this.emitPasswordRequired(false, error);
      return;
    }
    if (error === 'No Password Access') {
      // The remote user must accept the session; keep waiting for peer_info.
      return;
    }
    if (error) throw mapLoginError(error);

    const info = response.peer_info;
    if (!info) return;
    if (info.displays.length === 0) {
      throw new RustDeskError('protocol-error', 'The remote peer reports no displays');
    }
    return mapPeerInfo(info);
  }

  private handlePermission(info: message.PermissionInfo): void {
    const permission = permissionNameFromWire(info.permission);
    if (!permission) return;
    try {
      this.options.onPermission?.({ permission, enabled: info.enabled });
    } catch {
      // Host callbacks must not break the protocol loop.
    }
  }

  private sendLogin(password: string): void {
    const hash = this.hash;
    if (!hash) throw new RustDeskError('protocol-error', 'Cannot log in before receiving Hash');

    const advertise = this.options.advertiseWebClientVersion ?? false;
    const option = message.OptionMessage.fromPartial({
      image_quality: IMAGE_QUALITY[this.options.imageQuality ?? 'balanced'],
      disable_audio: message.OptionMessage_BoolOption.Yes,
      show_remote_cursor: message.OptionMessage_BoolOption.No,
    });
    this.channel.sendMessage({
      login_request: {
        username: this.options.peerId,
        my_id: 'web',
        my_name: 'web',
        password: challengeResponse(password, hash.salt, hash.challenge),
        option,
        video_ack_required: true,
        version: advertise ? WEB_CLIENT_VERSION : '',
        my_platform: advertise ? 'web' : '',
      },
    });
    this.emitStatus({ status: 'authenticating' });
    this.startApprovalTimer();
  }

  private startApprovalTimer(): void {
    this.clearApprovalTimer();
    const delay = this.options.approvalAfterMs ?? DEFAULT_APPROVAL_AFTER_MS;
    this.approvalTimer = setTimeout(() => {
      this.approvalTimer = undefined;
      if (!this.settled) this.emitStatus({ status: 'awaiting-approval' });
    }, delay);
  }

  private clearApprovalTimer(): void {
    if (this.approvalTimer) {
      clearTimeout(this.approvalTimer);
      this.approvalTimer = undefined;
    }
  }

  private sendHeartbeat(): void {
    if (this.settled) return;
    try {
      this.channel.sendMessage({
        test_delay: { time: Date.now(), from_client: true },
      });
    } catch {
      // A closed socket surfaces through nextMessage; timers must not throw.
    }
  }

  private emitPasswordRequired(retry: boolean, detail?: string): void {
    this.emitStatus({ status: 'password-required', retry, detail });
  }

  private emitStatus(event: RustDeskStatusEvent): void {
    try {
      this.options.onStatus?.(event);
    } catch {
      // Host callbacks must not break the protocol loop.
    }
  }

  private cleanup(): void {
    this.clearApprovalTimer();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
