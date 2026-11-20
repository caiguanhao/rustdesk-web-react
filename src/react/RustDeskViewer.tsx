/**
 * `<RustDeskViewer/>` — the embeddable remote-desktop component (P4-3).
 *
 * The component owns the DOM side of a session: the video canvas and
 * letterboxed renderer, the mouse/keyboard/touch/IME controllers, the status
 * overlay (password/error/retry), the toolbar and the manual-copy affordance.
 * The React lifecycle itself lives in `useRustDeskSession`, so the session is
 * created in an effect, survives StrictMode's double mount with only one
 * socket, and is disposed on unmount.
 *
 * Input gating has two owners by design: `session.bindInputs()` applies the
 * peer/local permission policy (P3-6), then this component intersects it with
 * the live session status and viewer focus. The keyboard listener lives on
 * `document`, so it must stay disabled until the user focuses the viewer; the
 * password form only exists while `password-required`, where the status gate
 * already disables all input. The IME textarea counts as viewer focus (P3-3)
 * so physical keys keep working while it has focus.
 *
 * Touch pinch zoom is applied here rather than by TouchInput
 * (`applyLocalZoom: false`) so the transform and its reset live with the
 * canvas; writes go straight to the DOM (no React render per pointermove).
 * `VideoRenderer.toRemote` maps through the transformed client rect.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  FormEvent,
  ReactNode,
} from 'react';
import type { RemoteClipboardEvent } from '../input/clipboard.js';
import { ImeInput } from '../input/ime.js';
import { KeyboardInput } from '../input/keyboard.js';
import { MouseInput } from '../input/mouse.js';
import { TouchInput, type LocalZoomState } from '../input/touch.js';
import { VideoRenderer } from '../media/renderer.js';
import { RustDeskError } from '../session/errors.js';
import type {
  RustDeskPasswordCredential,
  RustDeskSessionConfig,
} from '../session/options.js';
import type { PeerInfo } from '../session/peer-info.js';
import { applyInputPolicy } from '../session/permissions.js';
import { isPromiseLike } from '../session/promise.js';
import {
  isActiveStatus,
  type RustDeskStatusEvent,
  type SessionStats,
} from '../session/state.js';
import { useRustDeskSession } from './useRustDeskSession.js';

/** UI strings the host may override; all have English defaults. */
export interface RustDeskViewerLabels {
  connect: string;
  disconnect: string;
  retry: string;
  fullscreen: string;
  keyboard: string;
  clipboard: string;
  paste: string;
  /** Shown when the Clipboard API is unavailable (plain-HTTP pages). */
  pastePrompt: string;
  /** Submit label for the paste prompt. */
  send: string;
  copy: string;
  ctrlAltDel: string;
  passwordPrompt: string;
  passwordPlaceholder: string;
  submit: string;
  cancel: string;
  connecting: string;
  awaitingApproval: string;
  connected: string;
  disconnected: string;
  readOnly: string;
}

const DEFAULT_LABELS: RustDeskViewerLabels = {
  connect: 'Connect',
  disconnect: 'Disconnect',
  retry: 'Retry',
  fullscreen: 'Fullscreen',
  keyboard: 'Keyboard',
  clipboard: 'Clipboard',
  paste: 'Paste',
  pastePrompt: 'Paste the text to send to the remote clipboard',
  send: 'Send',
  copy: 'Copy',
  ctrlAltDel: 'Ctrl+Alt+Del',
  passwordPrompt: 'Enter the remote device password',
  passwordPlaceholder: 'Password',
  submit: 'Connect',
  cancel: 'Cancel',
  connecting: 'Connecting…',
  awaitingApproval: 'Waiting for the remote user to accept…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  readOnly: 'View only',
};

/** `navigator.clipboard` only exists in secure contexts (HTTPS/localhost). */
function canReadBrowserClipboard(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.readText === 'function'
  );
}

export interface PasswordPrompt {
  /** True when the peer rejected a previously supplied password. */
  retry: boolean;
  /** Non-secret error from the peer (e.g. `Wrong Password`). */
  error?: string;
}

export interface RustDeskViewerProps extends RustDeskSessionConfig {
  className?: string;
  style?: CSSProperties;
  /** Connect as soon as the component mounts. Defaults to true. */
  autoConnect?: boolean;
  /** Render the built-in toolbar. Defaults to true. */
  showToolbar?: boolean;
  /** Override any subset of the built-in strings. */
  labels?: Partial<RustDeskViewerLabels>;
  onStatusChange?: (event: RustDeskStatusEvent) => void;
  /**
   * Return a credential to log in automatically; return undefined to show the
   * built-in password form. A string is plaintext; `{ hash, salt? }` is a
   * pre-hashed h1. Invoked again with `retry: true` after a rejection.
   */
  onPasswordRequired?: (
    prompt: PasswordPrompt,
  ) =>
    | RustDeskPasswordCredential
    | undefined
    | Promise<RustDeskPasswordCredential | undefined>;
  onError?: (error: RustDeskError) => void;
  /** Remote clipboard text, already decompressed. */
  onClipboard?: (text: string) => void;
  onPeerInfo?: (info: PeerInfo) => void;
  /**
   * Delivery statistics. Accepted for API compatibility; the session has no
   * fps/decode producer yet (deferred to P5-3), so it is never invoked.
   */
  onStats?: (stats: SessionStats) => void;
}

/** Imperative commands exposed through `ref`. */
export interface RustDeskViewerRef {
  /** Connect (or reconnect) and resolve once `peer_info` arrives. */
  connect(credential?: RustDeskPasswordCredential): Promise<PeerInfo>;
  disconnect(): void;
  sendCtrlAltDel(): void;
  setFullscreen(enabled: boolean): Promise<void>;
  /** Focus the hidden input so a mobile soft keyboard opens. */
  focusKeyboard(): void;
}

const SHELL_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  aspectRatio: '16 / 9',
  overflow: 'hidden',
  background: '#000',
  outline: 'none',
  font: '14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
  color: '#fff',
};

const OVERLAY_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 2,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  boxSizing: 'border-box',
  padding: 16,
  background: 'rgba(0, 0, 0, 0.62)',
  textAlign: 'center',
};

const PANEL_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  boxSizing: 'border-box',
  width: 'min(360px, 100%)',
  padding: 16,
  borderRadius: 8,
  background: 'rgba(24, 24, 24, 0.96)',
  textAlign: 'left',
};

const INPUT_STYLE: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  padding: '8px 10px',
  border: '1px solid #555',
  borderRadius: 4,
  background: '#111',
  color: '#fff',
  // At least 16px keeps iOS Safari from zooming the page on focus.
  fontSize: 16,
};

const TEXTAREA_STYLE: CSSProperties = {
  ...INPUT_STYLE,
  minHeight: 96,
  resize: 'vertical',
  fontFamily: 'inherit',
};

const BUTTON_STYLE: CSSProperties = {
  padding: '6px 12px',
  border: '1px solid rgba(255, 255, 255, 0.3)',
  borderRadius: 4,
  background: 'rgba(255, 255, 255, 0.12)',
  color: '#fff',
  font: 'inherit',
  cursor: 'pointer',
};

const DETAIL_STYLE: CSSProperties = {
  margin: 0,
  color: '#ffb4b4',
  fontSize: 13,
};

const TOOLBAR_STYLE: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 8,
  zIndex: 2,
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'center',
  gap: 4,
  maxWidth: 'calc(100% - 16px)',
  boxSizing: 'border-box',
  padding: 4,
  borderRadius: 6,
  background: 'rgba(0, 0, 0, 0.55)',
  transform: 'translateX(-50%)',
};

const TOOLBAR_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_STYLE,
  padding: '4px 8px',
  fontSize: 12,
};

const BADGE_STYLE: CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 8,
  zIndex: 3,
  padding: '2px 8px',
  borderRadius: 4,
  background: 'rgba(0, 0, 0, 0.65)',
  color: '#fff',
  fontSize: 12,
};

const NOTICES_STYLE: CSSProperties = {
  position: 'absolute',
  top: 8,
  left: '50%',
  zIndex: 3,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  maxWidth: 'calc(100% - 16px)',
  transform: 'translateX(-50%)',
  pointerEvents: 'none',
};

const NOTICE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '4px 8px',
  borderRadius: 4,
  background: 'rgba(30, 30, 30, 0.95)',
  color: '#fff',
  fontSize: 12,
  pointerEvents: 'auto',
};

const NOTICE_BUTTON_STYLE: CSSProperties = {
  ...TOOLBAR_BUTTON_STYLE,
  flex: '0 0 auto',
};

const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};

function connectionError(cause: unknown): RustDeskError {
  return cause instanceof RustDeskError
    ? cause
    : new RustDeskError('asset-load-failed', 'Failed to initialize the video canvas', {
        cause,
      });
}

export const RustDeskViewer = forwardRef<RustDeskViewerRef, RustDeskViewerProps>(
  function RustDeskViewer(props, ref) {
    const { className, style, showToolbar = true } = props;
    const labels: RustDeskViewerLabels = {
      ...DEFAULT_LABELS,
      ...props.labels,
    };

    // Latest props for callbacks invoked from effects/subscriptions; reading
    // through a ref keeps the hook's options from recreating the session.
    const propsRef = useRef(props);
    propsRef.current = props;

    const [focused, setFocused] = useState(false);
    const [imeFocused, setImeFocused] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [passwordInput, setPasswordInput] = useState('');
    const [clipboardNotice, setClipboardNotice] =
      useState<RemoteClipboardEvent | null>(null);
    const [pasteOpen, setPasteOpen] = useState(false);
    const [pasteText, setPasteText] = useState('');
    const [notice, setNotice] = useState<string | null>(null);
    const [fullscreen, setFullscreen] = useState(false);
    const [fullscreenSupported, setFullscreenSupported] = useState(false);

    const rootRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef<VideoRenderer | null>(null);
    const mouseRef = useRef<MouseInput | null>(null);
    const keyboardRef = useRef<KeyboardInput | null>(null);
    const touchRef = useRef<TouchInput | null>(null);
    const imeRef = useRef<ImeInput | null>(null);
    const passwordId = useId();
    const pasteId = useId();

    const {
      session,
      status,
      statusEvent,
      peerInfo,
      error,
      permission,
      connect,
      login,
      disconnect,
    } = useRustDeskSession(props, {
      autoConnect: props.autoConnect ?? true,
      onStatusChange: (event) => propsRef.current.onStatusChange?.(event),
      onError: (value) => {
        propsRef.current.onError?.(value);
        // Non-fatal notices (P3-6 revokes, security downgrade, a denied
        // clipboard gesture) do not change the status; surface them above
        // the video.
        if (
          value.code === 'no-permission' ||
          value.code === 'clipboard-unavailable'
        ) {
          setNotice(value.message);
        }
      },
      onClipboard: (event) => {
        // A successful auto-copy clears a stale manual-copy prompt.
        setClipboardNotice(event.copied ? null : event);
        propsRef.current.onClipboard?.(event.text);
      },
      onPeerInfo: (info) => propsRef.current.onPeerInfo?.(info),
      onSecurityDowngraded: (value) => setNotice(value.message),
    });

    // Auto-dismiss informational notices; a manual copy prompt stays until
    // the user copies/dismisses or a new clipboard event replaces it.
    useEffect(() => {
      if (!notice) return;
      const timer = setTimeout(() => setNotice(null), 6_000);
      return () => clearTimeout(timer);
    }, [notice]);

    // A disconnect/retry must not leave the paste prompt over the status UI.
    useEffect(() => {
      if (status !== 'connected') setPasteOpen(false);
    }, [status]);

    // Pinch zoom is a high-frequency gesture; write the transform directly
    // instead of routing each pointermove through a React render.
    const applyLocalZoom = useCallback((state: LocalZoomState): void => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (state.scale === 1) {
        canvas.style.transform = '';
        canvas.style.transformOrigin = '';
      } else {
        canvas.style.transformOrigin = '0 0';
        canvas.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
      }
    }, []);

    // Create the renderer once. jsdom/headless environments may not provide a
    // drawable canvas; fail into an onError notice instead of crashing the
    // host page, and keep the status/password UI usable.
    useEffect(() => {
      const canvas = canvasRef.current;
      const root = rootRef.current;
      if (!canvas || !root) return;
      let renderer: VideoRenderer;
      try {
        renderer = new VideoRenderer(canvas, root, {
          onFullscreenChange: setFullscreen,
        });
      } catch (cause) {
        const value = connectionError(cause);
        propsRef.current.onError?.(value);
        setNotice(value.message);
        return;
      }
      rendererRef.current = renderer;
      setFullscreenSupported(renderer.fullscreenSupported);
      setFullscreen(renderer.fullscreen);
      return () => {
        rendererRef.current = null;
        renderer.dispose();
      };
    }, []);

    // The session decodes only while it has a sink. Effects run in declaration
    // order, so the renderer above exists by the time this runs after the
    // hook's session state update.
    useEffect(() => {
      if (!session) return;
      const renderer = rendererRef.current;
      if (!renderer) return;
      session.setVideoSink(renderer);
      return () => {
        session.setVideoSink(null);
      };
    }, [session]);

    // Build/attach the DOM input controllers and bind them to the session.
    // `bindInputs` applies the policy, display origin and peer keyboard
    // platform, and keeps them in sync after login/display changes.
    useEffect(() => {
      if (!session) return;
      const canvas = canvasRef.current;
      const root = rootRef.current;
      const renderer = rendererRef.current;
      if (!canvas || !root || !renderer) return;
      const report = (value: RustDeskError): void => {
        propsRef.current.onError?.(value);
      };
      const mouse = new MouseInput({
        element: canvas,
        mapper: renderer,
        channel: session,
        onError: report,
      });
      const keyboard = new KeyboardInput({
        channel: session,
        onError: report,
      });
      const touch = new TouchInput({
        element: canvas,
        mapper: renderer,
        channel: session,
        applyLocalZoom: false,
        onLocalZoom: applyLocalZoom,
        onError: report,
      });
      const ime = new ImeInput({
        channel: session,
        container: root,
        onFocusChange: setImeFocused,
        onError: report,
      });
      mouse.attach();
      keyboard.attach();
      touch.attach();
      ime.attach();
      mouseRef.current = mouse;
      keyboardRef.current = keyboard;
      touchRef.current = touch;
      imeRef.current = ime;
      session.bindInputs({ mouse, keyboard, touch, ime });

      return () => {
        mouseRef.current = null;
        keyboardRef.current = null;
        touchRef.current = null;
        imeRef.current = null;
        // Reset pinch zoom when the session ends/changes so a reconnect does
        // not inherit a stale transform.
        touch.resetLocalZoom();
        mouse.dispose();
        keyboard.dispose();
        touch.dispose();
        ime.dispose();
      };
    }, [session, applyLocalZoom]);

    // The authoritative viewer gate: policy ∩ live status ∩ focus. This is
    // the only place that enables controllers; `bindInputs` applies the raw
    // policy first, and this effect (declared after the controllers are
    // created) re-applies the derived effective policy on every change.
    useEffect(() => {
      const base = permission?.policy ?? session?.permissions.policy;
      if (!base) return;
      const connected = status === 'connected';
      applyInputPolicy(
        {
          ...base,
          mouse: connected && base.mouse,
          keyboard:
            connected &&
            base.keyboard &&
            (focused || imeFocused),
          touch: connected && base.touch,
          ime: connected && base.ime,
        },
        {
          mouse: mouseRef.current ?? undefined,
          keyboard: keyboardRef.current ?? undefined,
          touch: touchRef.current ?? undefined,
          ime: imeRef.current ?? undefined,
        },
      );
    }, [session, permission, status, focused, imeFocused]);

    // Reset zoom when the session ends so the next connection starts at 1:1.
    useEffect(() => {
      if (!isActiveStatus(status)) touchRef.current?.resetLocalZoom();
    }, [status]);

    // Password handling: ask the host first, fall back to the built-in form.
    // The effect is cancelled when the status changes so a late host answer
    // cannot log in after the user cancelled.
    useEffect(() => {
      if (statusEvent.status !== 'password-required') {
        setShowPassword(false);
        setPasswordInput('');
        return;
      }
      setPasswordInput('');
      const handler = propsRef.current.onPasswordRequired;
      if (!handler) {
        setShowPassword(true);
        return;
      }
      let cancelled = false;
      let result:
        | RustDeskPasswordCredential
        | undefined
        | Promise<RustDeskPasswordCredential | undefined>;
      try {
        result = handler({
          retry: statusEvent.retry,
          error: statusEvent.detail,
        });
      } catch {
        setShowPassword(true);
        return;
      }
      const logIn = (credential: RustDeskPasswordCredential | undefined): void => {
        if (cancelled) return;
        if (credential === undefined || credential === null || credential === '') {
          setShowPassword(true);
          return;
        }
        setShowPassword(false);
        void login(credential).catch(() => {
          if (!cancelled) setShowPassword(true);
        });
      };
      if (!isPromiseLike(result)) {
        logIn(result);
        return;
      }
      setShowPassword(false);
      void result.then(
        (credential) => logIn(credential),
        () => {
          if (!cancelled) setShowPassword(true);
        },
      );
      return () => {
        cancelled = true;
      };
    }, [statusEvent, login]);

    const handleRootFocus = (): void => setFocused(true);
    const handleRootBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
      const next = event.relatedTarget as Node | null;
      if (next && rootRef.current?.contains(next)) return;
      setFocused(false);
      setImeFocused(false);
    };

    const focusViewer = (): void => {
      rootRef.current?.focus({ preventScroll: true });
    };

    const handleConnect = (): void => {
      void connect().catch(() => {
        // Status/error events drive the UI.
      });
    };

    const submitPassword = (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const value = passwordInput;
      if (!value) return;
      setPasswordInput('');
      setShowPassword(false);
      void login(value).catch(() => setShowPassword(true));
    };

    // The password effect clears the input/form whenever the status leaves
    // `password-required`, so every disconnect path can share this.
    const handleDisconnect = useCallback((): void => {
      setShowPassword(false);
      disconnect();
    }, [disconnect]);

    const copyRemote = (): void => {
      void session
        ?.copyRemoteText()
        .catch(() => false)
        .then((copied) => {
          if (copied) setClipboardNotice(null);
        });
    };

    const pasteRemote = (): void => {
      // Plain-HTTP pages have no `navigator.clipboard` (not a secure
      // context), so reading silently fails. Offer a visible textarea where
      // the user can long-press/paste instead.
      if (!canReadBrowserClipboard()) {
        setPasteText('');
        setPasteOpen(true);
        return;
      }
      // A denied permission or an empty clipboard also lands here; the
      // prompt is a harmless manual fallback in both cases.
      void session
        ?.sendLocalClipboard()
        .then((sent) => {
          if (sent) return;
          setPasteText('');
          setPasteOpen(true);
        })
        .catch(() => false);
    };

    const submitPaste = (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (pasteText.length === 0) return;
      session?.sendText(pasteText);
      setPasteText('');
      setPasteOpen(false);
    };

    const policy = permission?.policy;
    const connected = status === 'connected';
    const canInput = connected && !props.readOnly;
    const canKeyboard = canInput && (policy?.ime ?? true);
    const canPaste = canInput && (policy?.clipboardSend ?? true);
    const canCtrlAltDel =
      canInput &&
      peerInfo?.sasEnabled === true &&
      (policy?.keyboard ?? true);

    const focusKeyboard = useCallback((): void => {
      if (!canKeyboard) return;
      imeRef.current?.focus();
    }, [canKeyboard]);

    const sendCtrlAltDel = useCallback((): void => {
      if (!canCtrlAltDel) return;
      keyboardRef.current?.sendCtrlAltDel();
    }, [canCtrlAltDel]);

    const setFullscreenEnabled = useCallback(
      async (enabled: boolean): Promise<void> => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        if (enabled) await renderer.requestFullscreen();
        else await renderer.exitFullscreen();
      },
      [],
    );

    useImperativeHandle(
      ref,
      () => ({
        connect: (credential?: RustDeskPasswordCredential) =>
          connect(credential),
        disconnect: handleDisconnect,
        sendCtrlAltDel,
        setFullscreen: setFullscreenEnabled,
        focusKeyboard,
      }),
      [
        connect,
        handleDisconnect,
        sendCtrlAltDel,
        setFullscreenEnabled,
        focusKeyboard,
      ],
    );

    let overlay: ReactNode = null;
    if (statusEvent.status === 'password-required' && showPassword) {
      overlay = (
        <div style={OVERLAY_STYLE} data-rustdesk-overlay="password">
          <form style={PANEL_STYLE} onSubmit={submitPassword}>
            <label htmlFor={passwordId}>{labels.passwordPrompt}</label>
            {statusEvent.detail ? (
              <p role="alert" style={DETAIL_STYLE}>
                {statusEvent.detail}
              </p>
            ) : null}
            <input
              id={passwordId}
              style={INPUT_STYLE}
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder={labels.passwordPlaceholder}
              value={passwordInput}
              onChange={(event) => setPasswordInput(event.target.value)}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                style={BUTTON_STYLE}
                onClick={handleDisconnect}
              >
                {labels.cancel}
              </button>
              <button
                type="submit"
                style={BUTTON_STYLE}
                disabled={passwordInput.length === 0}
              >
                {labels.submit}
              </button>
            </div>
          </form>
        </div>
      );
    } else if (pasteOpen && status === 'connected') {
      overlay = (
        <div style={OVERLAY_STYLE} data-rustdesk-overlay="paste">
          <form style={PANEL_STYLE} onSubmit={submitPaste}>
            <label htmlFor={pasteId}>{labels.pastePrompt}</label>
            <textarea
              id={pasteId}
              autoFocus
              rows={4}
              style={TEXTAREA_STYLE}
              placeholder={labels.paste}
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                style={BUTTON_STYLE}
                onClick={() => setPasteOpen(false)}
              >
                {labels.cancel}
              </button>
              <button
                type="submit"
                style={BUTTON_STYLE}
                disabled={pasteText.length === 0}
              >
                {labels.send}
              </button>
            </div>
          </form>
        </div>
      );
    } else if (status !== 'connected') {
      // `password-required` with the form hidden means auto-login is in
      // flight; all other active states show the connecting message.
      let message = labels.connecting;
      let detail: string | undefined;
      let action: { label: string; run: () => void } | undefined;
      switch (status) {
        case 'idle':
          message = '';
          action = { label: labels.connect, run: handleConnect };
          break;
        case 'awaiting-approval':
          message = labels.awaitingApproval;
          break;
        case 'disconnected':
          message = labels.disconnected;
          detail = statusEvent.detail;
          action = { label: labels.connect, run: handleConnect };
          break;
        case 'error':
          message = error?.message ?? statusEvent.detail ?? labels.retry;
          detail =
            statusEvent.detail && statusEvent.detail !== message
              ? statusEvent.detail
              : undefined;
          action = { label: labels.retry, run: handleConnect };
          break;
        default:
          break;
      }
      overlay = (
        <div style={OVERLAY_STYLE} data-rustdesk-overlay={status}>
          {message ? (
            <p role="status" style={{ margin: 0 }} data-rustdesk-status-text="">
              {message}
            </p>
          ) : null}
          {detail ? (
            <p style={DETAIL_STYLE} data-rustdesk-status-detail="">
              {detail}
            </p>
          ) : null}
          {action ? (
            <button type="button" style={BUTTON_STYLE} onClick={action.run}>
              {action.label}
            </button>
          ) : null}
        </div>
      );
    }

    return (
      <div
        ref={rootRef}
        className={className}
        style={{ ...SHELL_STYLE, ...style }}
        data-rustdesk-viewer=""
        data-status={status}
        tabIndex={0}
        onFocus={handleRootFocus}
        onBlur={handleRootBlur}
      >
        <canvas
          ref={canvasRef}
          data-rustdesk-canvas=""
          onPointerDown={focusViewer}
        />
        {overlay}
        <span style={VISUALLY_HIDDEN_STYLE} aria-live="polite">
          {status === 'connected' ? labels.connected : ''}
        </span>
        {props.readOnly ? (
          <span style={BADGE_STYLE} data-rustdesk-readonly="">
            {labels.readOnly}
          </span>
        ) : null}
        {showToolbar ? (
          <div
            style={TOOLBAR_STYLE}
            role="toolbar"
            aria-label="Remote desktop controls"
            data-rustdesk-toolbar=""
          >
            {peerInfo?.sasEnabled ? (
              <button
                type="button"
                style={TOOLBAR_BUTTON_STYLE}
                disabled={!canCtrlAltDel}
                onClick={sendCtrlAltDel}
              >
                {labels.ctrlAltDel}
              </button>
            ) : null}
            <button
              type="button"
              style={TOOLBAR_BUTTON_STYLE}
              disabled={!fullscreenSupported}
              aria-pressed={fullscreen}
              onClick={() => {
                void setFullscreenEnabled(!fullscreen);
              }}
            >
              {labels.fullscreen}
            </button>
            <button
              type="button"
              style={TOOLBAR_BUTTON_STYLE}
              disabled={!canKeyboard}
              onClick={focusKeyboard}
            >
              {labels.keyboard}
            </button>
            <button
              type="button"
              style={TOOLBAR_BUTTON_STYLE}
              disabled={!canPaste}
              title={labels.paste}
              onClick={pasteRemote}
            >
              {labels.clipboard}
            </button>
            <button
              type="button"
              style={TOOLBAR_BUTTON_STYLE}
              disabled={!session || !isActiveStatus(status)}
              onClick={handleDisconnect}
            >
              {labels.disconnect}
            </button>
          </div>
        ) : null}
        {notice || clipboardNotice ? (
          <div style={NOTICES_STYLE} data-rustdesk-notices="">
            {notice ? (
              <div style={NOTICE_STYLE} role="alert" data-rustdesk-notice="">
                <span>{notice}</span>
                <button
                  type="button"
                  style={NOTICE_BUTTON_STYLE}
                  aria-label={labels.cancel}
                  onClick={() => setNotice(null)}
                >
                  ×
                </button>
              </div>
            ) : null}
            {clipboardNotice ? (
              <div
                style={NOTICE_STYLE}
                role="status"
                data-rustdesk-clipboard-notice=""
              >
                <button
                  type="button"
                  style={NOTICE_BUTTON_STYLE}
                  onClick={copyRemote}
                >
                  {labels.copy}
                </button>
                <button
                  type="button"
                  style={NOTICE_BUTTON_STYLE}
                  aria-label={labels.cancel}
                  onClick={() => setClipboardNotice(null)}
                >
                  ×
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  },
);
