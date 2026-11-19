/**
 * `<RustDeskViewer/>` public API skeleton.
 *
 * P0-4 defines the embeddable shell and its complete prop/ref types so host
 * apps can integrate against a stable surface. The session wiring, canvas,
 * overlay and toolbar land in P4-3; until then the ref methods throw a plain
 * `Error` (not a public error code) instead of silently doing nothing.
 */
import { forwardRef, useImperativeHandle } from 'react';
import type { CSSProperties } from 'react';
import type { RustDeskError } from '../session/errors.js';
import type { RustDeskSessionConfig } from '../session/options.js';
import type { PeerInfo } from '../session/peer-info.js';
import type { RustDeskStatusEvent, SessionStats } from '../session/state.js';

/** UI strings the host may override; English defaults arrive with P4-3. */
export interface RustDeskViewerLabels {
  connect: string;
  disconnect: string;
  retry: string;
  fullscreen: string;
  keyboard: string;
  clipboard: string;
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
   * Return a password to log in automatically; return undefined to show the
   * built-in password form. Invoked again with `retry: true` after a rejection.
   */
  onPasswordRequired?: (
    prompt: PasswordPrompt,
  ) => string | undefined | Promise<string | undefined>;
  onError?: (error: RustDeskError) => void;
  /** Remote clipboard text, already decompressed. */
  onClipboard?: (text: string) => void;
  onPeerInfo?: (info: PeerInfo) => void;
  onStats?: (stats: SessionStats) => void;
}

/** Imperative commands exposed through `ref`. */
export interface RustDeskViewerRef {
  /** Connect (or reconnect) and resolve once `peer_info` arrives. */
  connect(password?: string): Promise<PeerInfo>;
  disconnect(): void;
  sendCtrlAltDel(): void;
  setFullscreen(enabled: boolean): Promise<void>;
  /** Focus the hidden input so a mobile soft keyboard opens. */
  focusKeyboard(): void;
}

// Skeleton-only marker; not part of the public error contract because P4-3
// removes these stubs entirely.
function notImplemented(method: string): never {
  throw new Error(
    `RustDeskViewer.${method}() is not wired yet (P4-3); the component currently renders only the layout shell.`,
  );
}

const FAIL_LOUDLY_HANDLE: RustDeskViewerRef = {
  connect: () => notImplemented('connect'),
  disconnect: () => notImplemented('disconnect'),
  sendCtrlAltDel: () => notImplemented('sendCtrlAltDel'),
  setFullscreen: () => notImplemented('setFullscreen'),
  focusKeyboard: () => notImplemented('focusKeyboard'),
};

const SHELL_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  aspectRatio: '16 / 9',
  overflow: 'hidden',
  background: '#000',
};

export const RustDeskViewer = forwardRef<RustDeskViewerRef, RustDeskViewerProps>(
  function RustDeskViewer({ className, style }, ref) {
    useImperativeHandle(ref, () => FAIL_LOUDLY_HANDLE, []);

    // P4-3 adds the canvas, status overlay, password form and toolbar here.
    return (
      <div
        className={className}
        style={{ ...SHELL_STYLE, ...style }}
        data-rustdesk-viewer=""
        data-status="idle"
      />
    );
  },
);
