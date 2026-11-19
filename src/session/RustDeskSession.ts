/**
 * Framework-agnostic RustDesk session (P4-1).
 *
 * `connect()` runs rendezvous/relay setup, the signed handshake and login,
 * then owns the post-login message loop that `LoginFlow` deliberately stops
 * at `peer_info`. The loop keeps the peer alive (TestDelay echo + heartbeat),
 * replays permission/clipboard/video messages, and routes video through the
 * bounded `VideoPipeline`. The session never draws: the host supplies a
 * `VideoSink` and the session only decodes and calls `draw(frame, release)`.
 *
 * Status mapping: P4-1 emits `connecting`, `securing`, `disconnected`, `idle`
 * and `error`; `LoginFlow` contributes `authenticating`, `password-required`,
 * `awaiting-approval` and `connected`. `login(password)` retries on the same
 * Hash after a `password-required` event and resolves with the `PeerInfo`
 * from the pending `connect()`.
 *
 * Permission state is created before login so `LoginFlow.onPermission` can
 * apply the host's login snapshot. Post-login `Misc.permission_info` is
 * routed to `SessionPermissions.handleMessage()`. The clipboard controller
 * always exists and uses this session as its channel; the viewer binds the
 * DOM input controllers with `bindInputs()` once it has created them.
 */
import type { WebSocketFactory } from '../protocol/websock.js';
import {
  connectRelay,
  type RelayConnection,
  type RendezvousConnectOptions,
} from '../protocol/connection.js';
import {
  LoginFlow,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
} from '../protocol/login.js';
import {
  KeyboardMode,
  type DeepPartial,
  type KeyEvent,
  type Message,
  type MouseEvent,
  type SwitchDisplay,
  type TestDelay,
} from '../protocol/message.js';
import {
  Vp9Decoder,
  type Vp9DecoderOptions,
} from '../media/vp9-decoder.js';
import {
  VideoPipeline,
  type VideoDecoder,
  type VideoSink,
} from '../media/video-pipeline.js';
import {
  ClipboardController,
  type RemoteClipboardEvent,
} from '../input/clipboard.js';
import { RustDeskError } from './errors.js';
import type { RustDeskSessionConfig } from './options.js';
import {
  applyDisplayList,
  isDisplayIndex,
  type PeerInfo,
} from './peer-info.js';
import {
  SessionPermissions,
  type InputTarget,
  type PermissionEvent,
} from './permissions.js';
import {
  isActiveStatus,
  type RustDeskStatus,
  type RustDeskStatusEvent,
} from './state.js';

export type SessionVideoDecoder = VideoDecoder & { dispose(): void };

export interface RustDeskSessionEvents {
  status: RustDeskStatusEvent;
  error: RustDeskError;
  /** Remote text after the auto-copy attempt (copied=false → manual button). */
  clipboard: RemoteClipboardEvent;
  permission: PermissionEvent;
  /** First peer_info and mid-session display-list updates. */
  peerInfo: PeerInfo;
  /** Emitted when allowInsecureFallback downgraded the secure handshake. */
  securityDowngraded: RustDeskError;
}

/**
 * Test/Node injection seams. Host apps normally construct the session with
 * `new RustDeskSession(config)` and never pass this object.
 */
export interface RustDeskSessionDeps {
  connectRelay?: (options: RendezvousConnectOptions) => Promise<RelayConnection>;
  createDecoder?: (options: Vp9DecoderOptions) => Promise<SessionVideoDecoder>;
  createSocket?: WebSocketFactory;
  autoCopyClipboard?: boolean;
  /** ws:// vs wss:// (defaults to the page protocol). */
  secure?: boolean;
  /** Shorter login/approval/heartbeat timers for tests. */
  approvalAfterMs?: number;
  heartbeatIntervalMs?: number;
}

/** Viewer-owned DOM controllers plus the PeerInfo-derived setters. */
export interface SessionInputTargets {
  mouse?: InputTarget & { setOrigin?(origin: { x: number; y: number }): void };
  keyboard?: InputTarget & { setPlatform?(platform: string): void };
  touch?: InputTarget & { setOrigin?(origin: { x: number; y: number }): void };
  ime?: InputTarget;
}

type Listener<T> = (payload: T) => void;

const DEFAULT_LOOP_TIMEOUT_MS = 30_000;

function abortError(): RustDeskError {
  return new RustDeskError('aborted', 'Session operation aborted');
}

function invalidState(action: string): RustDeskError {
  return new RustDeskError(
    'invalid-state',
    `Cannot ${action} in the current session state`,
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof RustDeskError && error.code === 'aborted';
}

export class RustDeskSession {
  private readonly config: RustDeskSessionConfig;
  private readonly deps: RustDeskSessionDeps;
  private readonly now: () => number;
  private readonly listeners = new Map<
    keyof RustDeskSessionEvents,
    Set<Listener<never>>
  >();
  private readonly permissionState: SessionPermissions;
  private readonly clipboard: ClipboardController;
  private readonly sinkRouter: VideoSink;
  private videoSink?: VideoSink;
  private statusValue: RustDeskStatus = 'idle';
  private connection?: RelayConnection;
  private flow?: LoginFlow;
  private peerInfoValue?: PeerInfo;
  private loginPromise?: Promise<PeerInfo>;
  private passwordRequiredValue = false;
  private lifecycle?: AbortController;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private runId = 0;
  private disposed = false;
  private cleanupPromise?: Promise<void>;
  private pipeline?: VideoPipeline;
  private decoder?: SessionVideoDecoder;
  private videoInit?: Promise<void>;
  private latencyValue = 0;
  private inputTargets?: SessionInputTargets;
  private readonly onVisibilityChange = (): void => {
    if (typeof document === 'undefined') return;
    this.pipeline?.handleVisibilityChange(
      document.visibilityState !== 'hidden',
    );
  };

  constructor(config: RustDeskSessionConfig, deps: RustDeskSessionDeps = {}) {
    this.config = config;
    this.deps = deps;
    this.now = Date.now;
    this.permissionState = new SessionPermissions({
      readOnly: config.readOnly ?? false,
      disableClipboard: config.disableClipboard ?? false,
      onChange: (event) => this.emit('permission', event),
      onError: (error) => this.emit('error', error),
    });
    this.clipboard = new ClipboardController({
      channel: this,
      autoCopy: deps.autoCopyClipboard ?? true,
      sendSeq: (text) => this.sendSeq(text),
      onRemoteText: (event) => this.emit('clipboard', event),
      onError: (error) => this.emit('error', error),
    });
    this.permissionState.bind({ clipboard: this.clipboard });
    this.sinkRouter = {
      draw: (frame, release) => {
        const sink = this.videoSink;
        if (sink) sink.draw(frame, release);
        else release();
      },
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  get status(): RustDeskStatus {
    return this.statusValue;
  }

  get connected(): boolean {
    return this.statusValue === 'connected';
  }

  get peerInfo(): PeerInfo | undefined {
    return this.peerInfoValue;
  }

  get permissions(): SessionPermissions {
    return this.permissionState;
  }

  get currentDisplay(): number {
    return this.peerInfoValue?.currentDisplay ?? 0;
  }

  get latencyMs(): number {
    return this.latencyValue;
  }

  /** Subscribe to a typed event; the returned function removes the listener. */
  on<K extends keyof RustDeskSessionEvents>(
    type: K,
    listener: Listener<RustDeskSessionEvents[K]>,
  ): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set!.delete(listener as Listener<never>);
      if (set!.size === 0) this.listeners.delete(type);
    };
  }

  /**
   * Connect, sign, log in and start the session loop. Resolves with the first
   * `PeerInfo`; with no password the promise stays pending through
   * `password-required` until `login()` succeeds. Rejects on abort/errors.
   */
  async connect(signal?: AbortSignal): Promise<PeerInfo> {
    if (this.disposed) throw abortError();
    if (this.cleanupPromise) await this.cleanupPromise;
    if (this.disposed) throw abortError();
    if (isActiveStatus(this.statusValue)) {
      throw invalidState('connect');
    }

    const runId = ++this.runId;
    this.passwordRequiredValue = false;
    this.peerInfoValue = undefined;
    this.latencyValue = 0;
    this.clipboard.reset();
    this.resetPeerPermissions();
    this.setStatus({ status: 'connecting' });

    const lifecycle = new AbortController();
    this.lifecycle = lifecycle;
    const unlink = this.linkAbort(signal, lifecycle);
    try {
      const connection = await (this.deps.connectRelay ?? connectRelay)({
        server: this.config.server,
        peerId: this.config.id,
        serverKey: this.config.serverKey,
        relayServer: this.config.relayServer,
        rendezvousUrl: this.config.rendezvousUrl,
        relayUrl: this.config.relayUrl,
        allowInsecureFallback: this.config.allowInsecureFallback,
        secure: this.deps.secure,
        createSocket: this.deps.createSocket,
        signal: lifecycle.signal,
        onSecuring: () => {
          if (this.isRun(runId)) this.setStatus({ status: 'securing' });
        },
      });
      if (!this.isRun(runId)) {
        connection.close();
        throw abortError();
      }
      this.connection = connection;
      if (!connection.secure) {
        this.emit(
          'securityDowngraded',
          connection.downgrade ??
            new RustDeskError(
              'protocol-error',
              'The secure handshake was skipped',
            ),
        );
      }

      const flow = new LoginFlow(connection, {
        peerId: this.config.id,
        password: this.config.password,
        imageQuality: this.config.imageQuality,
        advertiseWebClientVersion: this.config.advertiseWebClientVersion,
        disableClipboard:
          this.permissionState.readOnly ||
          this.permissionState.disableClipboard,
        approvalAfterMs: this.deps.approvalAfterMs,
        heartbeatIntervalMs: this.deps.heartbeatIntervalMs,
        onStatus: (event) => {
          if (!this.isRun(runId)) return;
          this.passwordRequiredValue = event.status === 'password-required';
          this.setStatus(event);
        },
        onPermission: (change) => {
          if (this.isRun(runId)) this.permissionState.apply(change);
        },
      });
      this.flow = flow;
      this.loginPromise = flow.start(undefined, lifecycle.signal);
      const peerInfo = await this.loginPromise;
      if (!this.isRun(runId)) throw abortError();

      this.peerInfoValue = peerInfo;
      this.passwordRequiredValue = false;
      this.syncInputPeer();
      this.emit('peerInfo', peerInfo);
      this.startPostLogin(runId);
      return peerInfo;
    } catch (error) {
      const typed = this.toError(error, 'Connection failed');
      if (this.isRun(runId)) {
        if (isAbort(typed)) this.endDisconnected('Connection aborted');
        else this.fail(typed, runId);
      }
      throw typed;
    } finally {
      unlink();
    }
  }

  /**
   * Retry after `password-required` using the same Hash. Returns the pending
   * `connect()` result (or a rejected promise when called in another state).
   */
  login(password: string): Promise<PeerInfo> {
    if (this.disposed) return Promise.reject(abortError());
    if (!this.flow || !this.loginPromise) {
      return Promise.reject(invalidState('log in'));
    }
    if (!this.passwordRequiredValue) {
      return Promise.reject(invalidState('log in'));
    }
    try {
      this.passwordRequiredValue = false;
      this.flow.login(password);
    } catch (error) {
      this.passwordRequiredValue = true;
      return Promise.reject(error);
    }
    return this.loginPromise;
  }

  /** Cleanly end the current connection; the session may connect again. */
  disconnect(): void {
    this.endDisconnected();
  }

  /** Tear down sockets, workers, timers and listeners. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.cleanupPromise;
      return;
    }
    this.disposed = true;
    this.setStatus({ status: 'idle' });
    await this.cleanupConnection();
    this.videoSink = undefined;
    this.inputTargets = undefined;
    this.peerInfoValue = undefined;
    this.clipboard.dispose();
    this.permissionState.dispose();
    this.listeners.clear();
    if (typeof document !== 'undefined') {
      document.removeEventListener(
        'visibilitychange',
        this.onVisibilityChange,
      );
    }
  }

  /** Supply or replace the video sink; `null` stops decoding. */
  setVideoSink(sink: VideoSink | null): void {
    if (this.disposed) return;
    this.videoSink = sink ?? undefined;
    if (sink && this.statusValue === 'connected') {
      this.ensureVideo();
    } else if (!sink) {
      void this.disposeVideo();
    }
  }

  /** Bind the viewer's DOM input controllers and the session clipboard. */
  bindInputs(targets: SessionInputTargets): void {
    if (this.disposed) return;
    this.inputTargets = targets;
    this.permissionState.bind({ ...targets, clipboard: this.clipboard });
    this.syncInputPeer();
  }

  setReadOnly(enabled: boolean): void {
    this.permissionState.setReadOnly(enabled);
  }

  setDisableClipboard(enabled: boolean): void {
    this.permissionState.setDisableClipboard(enabled);
  }

  /**
   * Low-level channel used by the input encoders (the session implements
   * `sendMessage`). Throws `connection-lost` before connect.
   */
  sendMessage(payload: DeepPartial<Message>): void {
    if (!this.connection) {
      throw new RustDeskError('connection-lost', 'Session is not connected');
    }
    this.connection.sendMessage(payload);
  }

  /** Send a protocol MouseEvent, gated by the current input policy. */
  sendMouse(event: MouseEvent): void {
    if (!this.permissionState.policy.mouse) return;
    this.sendMessage({ mouse_event: event });
  }

  /** Send a protocol KeyEvent, gated by the current input policy. */
  sendKey(event: KeyEvent): void {
    if (!this.permissionState.policy.keyboard) return;
    this.sendMessage({ key_event: event });
  }

  /** Shared local→remote text API (Clipboard message, seq fallback). */
  sendText(text: string): boolean {
    if (this.statusValue !== 'connected') return false;
    return this.clipboard.sendText(text);
  }

  /** Read the browser clipboard and send it (call from a user gesture). */
  sendLocalClipboard(): Promise<boolean> {
    if (this.statusValue !== 'connected') return Promise.resolve(false);
    return this.clipboard.sendLocalClipboard();
  }

  /** Copy the last remote text locally (call from a click on iOS). */
  copyRemoteText(): Promise<boolean> {
    return this.clipboard.copyRemoteText();
  }

  /** Switch the captured display after validating it against PeerInfo. */
  switchDisplay(index: number): void {
    if (this.disposed) return;
    const peer = this.peerInfoValue;
    if (!peer || !isDisplayIndex(index) || index >= peer.displays.length) {
      return;
    }
    if (index === this.currentDisplay) return;
    this.peerInfoValue = { ...peer, currentDisplay: index };
    this.syncInputPeer();
    this.emit('peerInfo', this.peerInfoValue);
    if (this.pipeline) {
      this.pipeline.switchDisplay(index);
    } else {
      try {
        this.sendMessage({ misc: { switch_display: { display: index } } });
      } catch (error) {
        this.report(error);
      }
    }
  }

  private startPostLogin(runId: number): void {
    this.startHeartbeat(runId);
    const pending = this.flow?.takePendingMessages() ?? [];
    for (const message of pending) {
      try {
        this.handleMessage(message, true);
      } catch (error) {
        this.report(error);
      }
    }
    if (!this.isRun(runId)) return;
    void this.runLoop(runId);
    this.ensureVideo();
  }

  private async runLoop(runId: number): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    for (;;) {
      if (!this.isRun(runId)) return;
      let message: Message;
      try {
        message = await connection.nextMessage(
          DEFAULT_LOOP_TIMEOUT_MS,
          this.lifecycle?.signal,
        );
      } catch (error) {
        if (!this.isRun(runId)) return;
        if (error instanceof RustDeskError && error.code === 'timeout') {
          // The peer probes every second; 30 s of silence means the link is
          // dead even if the WebSocket has not fired a close event.
          this.fail(
            new RustDeskError(
              'timeout',
              'No peer message within the session read timeout',
              { cause: error },
            ),
            runId,
          );
          return;
        }
        if (isAbort(error)) {
          this.endDisconnected('Connection aborted');
          return;
        }
        if (error instanceof RustDeskError && error.code === 'peer-closed') {
          this.endDisconnected(error.message);
          return;
        }
        this.fail(error, runId);
        return;
      }
      if (!this.isRun(runId)) return;
      try {
        this.handleMessage(message, false);
      } catch (error) {
        this.fail(error, runId);
        return;
      }
    }
  }

  private handleMessage(message: Message, pending: boolean): void {
    if (message.misc?.close_reason) {
      this.endDisconnected(message.misc.close_reason);
      return;
    }
    if (message.video_frame) {
      const video = message.video_frame;
      if (this.pipeline) {
        this.pipeline.push(video, { acked: pending });
        return;
      }
      if (!pending) {
        // No sink/decoder yet: keep the peer's ack gate open and drop.
        this.sendMessage({ misc: { video_received: true } });
      }
      if (!video.vp9s) {
        this.emit(
          'error',
          new RustDeskError(
            'unsupported-codec',
            'The peer sent a non-VP9 video frame; reconnect so it negotiates VP9 only.',
          ),
        );
      }
      return;
    }
    if (message.test_delay) {
      this.handleTestDelay(message.test_delay);
      return;
    }
    if (message.clipboard || message.multi_clipboards) {
      void this.clipboard.handleMessage(message);
      return;
    }
    if (message.misc?.permission_info) {
      this.permissionState.handleMessage(message);
      return;
    }
    if (message.misc?.switch_display) {
      this.handleSwitchDisplay(message.misc.switch_display);
      return;
    }
    if (message.peer_info) {
      this.handlePeerInfo(message.peer_info);
    }
  }

  private handleTestDelay(delay: TestDelay): void {
    if (!delay.from_client) {
      this.sendMessage({ test_delay: delay });
      return;
    }
    const sentAt = Number(delay.time);
    if (Number.isFinite(sentAt)) {
      this.latencyValue = Math.max(0, this.now() - sentAt);
    }
  }

  private handlePeerInfo(info: Message['peer_info']): void {
    if (!info || !this.peerInfoValue) return;
    const previousDisplay = this.currentDisplay;
    const next = applyDisplayList(this.peerInfoValue, info.displays);
    if (next === this.peerInfoValue) return;
    this.peerInfoValue = next;
    if (next.currentDisplay !== previousDisplay) {
      this.pipeline?.switchDisplay(next.currentDisplay);
    }
    this.syncInputPeer();
    this.emit('peerInfo', next);
  }

  private handleSwitchDisplay(sw: SwitchDisplay): void {
    const peer = this.peerInfoValue;
    if (
      !peer ||
      !isDisplayIndex(sw.display) ||
      sw.display >= peer.displays.length
    ) {
      return;
    }
    if (sw.display === this.currentDisplay) {
      this.pipeline?.handleSwitchDisplay(sw);
      return;
    }
    this.peerInfoValue = { ...peer, currentDisplay: sw.display };
    this.syncInputPeer();
    this.emit('peerInfo', this.peerInfoValue);
    this.pipeline?.handleSwitchDisplay(sw);
  }

  private startHeartbeat(runId: number): void {
    this.clearHeartbeat();
    this.sendHeartbeat(runId);
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeat(runId),
      this.deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
  }

  private sendHeartbeat(runId: number): void {
    if (!this.isRun(runId) || !this.connection) return;
    try {
      this.sendMessage({
        test_delay: { time: this.now(), from_client: true },
      });
    } catch (error) {
      this.fail(error, runId);
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private ensureVideo(): void {
    if (
      this.disposed ||
      !this.videoSink ||
      !this.connection ||
      this.statusValue !== 'connected' ||
      this.pipeline ||
      this.videoInit
    ) {
      return;
    }
    const create =
      this.deps.createDecoder ??
      ((options: Vp9DecoderOptions) => Vp9Decoder.create(options));
    let init!: Promise<void>;
    init = (async () => {
      let decoder: SessionVideoDecoder;
      try {
        decoder = await create({ assetBaseUrl: this.config.assetBaseUrl });
      } catch (cause) {
        if (this.videoInit === init) {
          this.report(
            new RustDeskError(
              'asset-load-failed',
              'Failed to start video decoding',
              { cause },
            ),
          );
        }
        return;
      }
      if (
        this.disposed ||
        this.videoInit !== init ||
        !this.connection ||
        !this.videoSink ||
        this.statusValue !== 'connected'
      ) {
        decoder.dispose();
        return;
      }
      this.decoder = decoder;
      const pipeline = new VideoPipeline({
        decoder,
        channel: this,
        sink: this.sinkRouter,
        initialDisplay: this.currentDisplay,
        onError: (error) => this.emit('error', error),
      });
      this.pipeline = pipeline;
      if (typeof document !== 'undefined') {
        pipeline.handleVisibilityChange(document.visibilityState !== 'hidden');
      }
      try {
        this.sendMessage({ misc: { refresh_video: true } });
      } catch {
        // The loop will surface a dead connection.
      }
    })();
    this.videoInit = init;
    void init.finally(() => {
      if (this.videoInit === init) this.videoInit = undefined;
    });
  }

  private async disposeVideo(): Promise<void> {
    const pipeline = this.pipeline;
    const decoder = this.decoder;
    this.pipeline = undefined;
    this.decoder = undefined;
    await pipeline?.dispose();
    decoder?.dispose();
  }

  private sendSeq(text: string): void {
    if (!this.permissionState.policy.ime) return;
    this.sendMessage({
      key_event: {
        seq: text,
        mode: KeyboardMode.Translate,
        down: true,
        press: false,
        modifiers: [],
      },
    });
  }

  private resetPeerPermissions(): void {
    // Local read-only/disableClipboard choices persist across reconnects.
    this.permissionState.resetPeerPermissions();
  }

  private endDisconnected(detail?: string): void {
    if (!isActiveStatus(this.statusValue)) return;
    this.setStatus({ status: 'disconnected', detail });
    void this.cleanupConnection();
  }

  private fail(error: unknown, runId: number): void {
    if (!this.isRun(runId)) return;
    if (isAbort(error)) {
      this.endDisconnected('Connection aborted');
      return;
    }
    if (
      this.statusValue === 'error' ||
      this.statusValue === 'disconnected' ||
      this.statusValue === 'idle'
    ) {
      return;
    }
    const typed = this.toError(error, 'Unexpected session failure');
    this.emit('error', typed);
    this.setStatus({ status: 'error', detail: typed.message });
    void this.cleanupConnection();
  }

  private report(error: unknown): void {
    this.emit(
      'error',
      this.toError(error, 'Session message handling failed'),
    );
  }

  private toError(error: unknown, message: string): RustDeskError {
    if (error instanceof RustDeskError) return error;
    return new RustDeskError('protocol-error', message, { cause: error });
  }

  private syncInputPeer(): void {
    const peer = this.peerInfoValue;
    const targets = this.inputTargets;
    if (!peer || !targets) return;
    const display = peer.displays[peer.currentDisplay];
    const origin = display
      ? { x: display.x, y: display.y }
      : { x: 0, y: 0 };
    targets.mouse?.setOrigin?.(origin);
    targets.touch?.setOrigin?.(origin);
    targets.keyboard?.setPlatform?.(peer.platform);
  }

  private cleanupConnection(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.runId += 1;
    this.clearHeartbeat();
    const flow = this.flow;
    const connection = this.connection;
    const lifecycle = this.lifecycle;
    this.flow = undefined;
    this.connection = undefined;
    this.lifecycle = undefined;
    this.loginPromise = undefined;
    this.passwordRequiredValue = false;
    flow?.dispose();
    lifecycle?.abort();
    connection?.close();
    const promise = this.disposeVideo().finally(() => {
      if (this.cleanupPromise === promise) {
        this.cleanupPromise = undefined;
      }
    });
    this.cleanupPromise = promise;
    return promise;
  }

  private setStatus(event: RustDeskStatusEvent): void {
    this.statusValue = event.status;
    this.emit('status', event);
  }

  private isRun(runId: number): boolean {
    return !this.disposed && this.runId === runId;
  }

  private linkAbort(
    signal: AbortSignal | undefined,
    lifecycle: AbortController,
  ): () => void {
    if (!signal) return () => undefined;
    if (signal.aborted) {
      lifecycle.abort();
      return () => undefined;
    }
    const onAbort = (): void => lifecycle.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  private emit<K extends keyof RustDeskSessionEvents>(
    type: K,
    payload: RustDeskSessionEvents[K],
  ): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<RustDeskSessionEvents[K]>)(payload);
      } catch {
        // Host listeners must not break the session loop.
      }
    }
  }

}
