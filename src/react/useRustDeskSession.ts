/**
 * React binding for RustDeskSession (P4-2).
 *
 * The hook owns one session per mounted/config generation. It creates the
 * session in an effect (never during render, so SSR stays safe), subscribes to
 * its typed events, auto-connects when requested, and disposes the session on
 * config changes/unmount. In React 18 StrictMode the first effect is torn down
 * immediately: `dispose()` aborts the connect attempt and closes the socket
 * before the second effect creates a fresh session. Events are ignored unless
 * they come from the current session, so a disposed session cannot update
 * React state.
 *
 * Connection-identity/login-time config changes recreate the session.
 * `readOnly`/`disableClipboard` are applied live through the session setters
 * and do not reconnect; `autoConnect` is read at creation time. `createSession`
 * is a stable test seam (defaults to `new RustDeskSession`). Callbacks are read
 * from a ref and never trigger reconnects.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteClipboardEvent } from '../input/clipboard.js';
import { RustDeskError } from '../session/errors.js';
import type { RustDeskSessionConfig } from '../session/options.js';
import type { PeerInfo } from '../session/peer-info.js';
import type { PermissionEvent } from '../session/permissions.js';
import {
  RustDeskSession,
  type RustDeskSessionEvents,
} from '../session/RustDeskSession.js';
import type { RustDeskStatus, RustDeskStatusEvent } from '../session/state.js';

export interface UseRustDeskSessionOptions {
  /** Connect as soon as the session is created. Defaults to true. */
  autoConnect?: boolean;
  /** Test seam; must be stable across renders. Defaults to RustDeskSession. */
  createSession?: (config: RustDeskSessionConfig) => RustDeskSession;
  onStatusChange?: (event: RustDeskStatusEvent) => void;
  onError?: (error: RustDeskError) => void;
  onClipboard?: (event: RemoteClipboardEvent) => void;
  onPeerInfo?: (info: PeerInfo) => void;
  onPermission?: (event: PermissionEvent) => void;
  onSecurityDowngraded?: (error: RustDeskError) => void;
}

export interface UseRustDeskSessionResult {
  /** Current session; null before the first effect and after cleanup. */
  session: RustDeskSession | null;
  status: RustDeskStatus;
  statusEvent: RustDeskStatusEvent;
  peerInfo?: PeerInfo;
  error?: RustDeskError;
  clipboard?: RemoteClipboardEvent;
  permission?: PermissionEvent;
  securityDowngrade?: RustDeskError;
  /**
   * Connect the current session; returns an in-flight attempt if present.
   * A password is used when the session is already `password-required`.
   */
  connect(password?: string): Promise<PeerInfo>;
  /** Retry after `password-required` on the same Hash. */
  login(password: string): Promise<PeerInfo>;
  /** Clean local disconnect; the hook/session can connect again. */
  disconnect(): void;
}

const IDLE_STATUS: RustDeskStatusEvent = { status: 'idle' };

function invalidState(message: string): RustDeskError {
  return new RustDeskError('invalid-state', message);
}

export function useRustDeskSession(
  config: RustDeskSessionConfig,
  options: UseRustDeskSessionOptions = {},
): UseRustDeskSessionResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [session, setSession] = useState<RustDeskSession | null>(null);
  const [statusEvent, setStatusEvent] =
    useState<RustDeskStatusEvent>(IDLE_STATUS);
  const [peerInfo, setPeerInfo] = useState<PeerInfo | undefined>();
  const [error, setError] = useState<RustDeskError | undefined>();
  const [clipboard, setClipboard] = useState<
    RemoteClipboardEvent | undefined
  >();
  const [permission, setPermission] = useState<PermissionEvent | undefined>();
  const [securityDowngrade, setSecurityDowngrade] = useState<
    RustDeskError | undefined
  >();

  const sessionRef = useRef<RustDeskSession | null>(null);
  const connectPromiseRef = useRef<Promise<PeerInfo> | undefined>();

  const connect = useCallback((password?: string): Promise<PeerInfo> => {
    const target = sessionRef.current;
    if (!target) {
      return Promise.reject(invalidState('The session is not mounted yet'));
    }
    if (password !== undefined && target.status === 'password-required') {
      return target.login(password);
    }
    if (connectPromiseRef.current) return connectPromiseRef.current;
    const promise = target.connect();
    connectPromiseRef.current = promise;
    const clear = (): void => {
      if (connectPromiseRef.current === promise) {
        connectPromiseRef.current = undefined;
      }
    };
    void promise.then(clear, clear);
    return promise;
  }, []);

  const login = useCallback((password: string): Promise<PeerInfo> => {
    const target = sessionRef.current;
    if (!target) {
      return Promise.reject(invalidState('The session is not mounted yet'));
    }
    return target.login(password);
  }, []);

  const disconnect = useCallback((): void => {
    sessionRef.current?.disconnect();
  }, []);

  const autoConnect = options.autoConnect ?? true;
  const {
    server,
    serverKey,
    id,
    password,
    relayServer,
    rendezvousUrl,
    relayUrl,
    assetBaseUrl,
    imageQuality,
    readOnly,
    disableClipboard,
    allowInsecureFallback,
    advertiseWebClientVersion,
  } = config;

  useEffect(() => {
    const currentOptions = optionsRef.current;
    const create =
      currentOptions.createSession ?? ((value) => new RustDeskSession(value));
    const created = create(config);
    sessionRef.current = created;
    setSession(created);
    setStatusEvent(IDLE_STATUS);
    setPeerInfo(undefined);
    setError(undefined);
    setClipboard(undefined);
    setPermission({
      policy: created.permissions.policy,
      permissions: created.permissions.permissions,
    });
    setSecurityDowngrade(undefined);

    const subscribe = <K extends keyof RustDeskSessionEvents>(
      type: K,
      handle: (value: RustDeskSessionEvents[K]) => void,
    ): (() => void) =>
      created.on(type, (value) => {
        if (sessionRef.current !== created) return;
        handle(value);
      });

    const unsubscribe = [
      subscribe('status', (event) => {
        setStatusEvent(event);
        if (event.status === 'connecting') setError(undefined);
        optionsRef.current.onStatusChange?.(event);
      }),
      subscribe('error', (value) => {
        setError(value);
        optionsRef.current.onError?.(value);
      }),
      subscribe('clipboard', (event) => {
        setClipboard(event);
        optionsRef.current.onClipboard?.(event);
      }),
      subscribe('peerInfo', (info) => {
        setPeerInfo(info);
        optionsRef.current.onPeerInfo?.(info);
      }),
      subscribe('permission', (event) => {
        setPermission(event);
        optionsRef.current.onPermission?.(event);
      }),
      subscribe('securityDowngraded', (value) => {
        setSecurityDowngrade(value);
        optionsRef.current.onSecurityDowngraded?.(value);
      }),
    ];

    if (autoConnect) {
      void connect().catch(() => {
        // The session reports fatal failures through its error event.
      });
    }

    return () => {
      for (const off of unsubscribe) off();
      if (sessionRef.current === created) sessionRef.current = null;
      connectPromiseRef.current = undefined;
      void created.dispose();
    };
  }, [
    server,
    serverKey,
    id,
    password,
    relayServer,
    rendezvousUrl,
    relayUrl,
    assetBaseUrl,
    imageQuality,
    allowInsecureFallback,
    advertiseWebClientVersion,
    connect,
  ]);

  // Local policy toggles apply to the live session; reconnect only when the
  // connection identity/login-time config above changes.
  useEffect(() => {
    const target = sessionRef.current;
    if (!target) return;
    target.setReadOnly(readOnly ?? false);
    target.setDisableClipboard(disableClipboard ?? false);
  }, [readOnly, disableClipboard, session]);

  return {
    session,
    status: statusEvent.status,
    statusEvent,
    peerInfo,
    error,
    clipboard,
    permission,
    securityDowngrade,
    connect,
    login,
    disconnect,
  };
}
