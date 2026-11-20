/**
 * P4-4 demo: the embeddable viewer behind a small connection form.
 *
 * Non-password fields are remembered in localStorage; the password is kept in
 * React state only and never written to storage or logs. `VITE_RD_PASSWORD`
 * may prefill it for local development (gitignored `.env.local`), but the
 * demo still never persists it. Submitting mounts a fresh <RustDeskViewer>
 * (lazy-loaded, so the form does not pay for the protocol/renderer graph) with
 * a snapshot of the form; "Change settings" unmounts/disposes it.
 */
import { lazy, Suspense, useState, type FormEvent } from 'react';
import type {
  PeerInfo,
  RustDeskSessionConfig,
  RustDeskStatusEvent,
} from 'rustdesk-web-react/core';

const env = import.meta.env;
const STORAGE_KEY = 'rustdesk-web-react.demo.form.v1';
/** Mirrors `DEFAULT_ASSET_BASE_URL`; the viewer applies it when empty. */
const DEFAULT_ASSET_BASE = '/rustdesk-assets/';

const FIELD_KEYS = [
  'server',
  'serverKey',
  'relayServer',
  'id',
  'assetBaseUrl',
] as const;
type FormField = (typeof FIELD_KEYS)[number];
type FormValues = Record<FormField, string>;

const RustDeskViewer = lazy(() =>
  import('rustdesk-web-react').then((module) => ({
    default: module.RustDeskViewer,
  })),
);

function environmentDefaults(): FormValues {
  return {
    server: env.VITE_RD_SERVER ?? '',
    serverKey: env.VITE_RD_KEY ?? '',
    relayServer: env.VITE_RD_RELAY ?? '',
    id: env.VITE_RD_ID ?? '',
    assetBaseUrl: env.VITE_RD_ASSET_BASE ?? '',
  };
}

/**
 * `?simd=0` / `?simd=1` forces the VP9 decoder path. Used by the P5 real-device
 * checklist to cover the non-SIMD build on devices that support SIMD.
 */
function decoderSimdFromUrl(): boolean | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = new URLSearchParams(window.location.search).get('simd');
  if (value === '0') return false;
  if (value === '1') return true;
  return undefined;
}

/** Env values are first-run defaults; later form submissions win. */
function loadForm(): FormValues {
  const values = environmentDefaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return values;
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return values;
    for (const field of FIELD_KEYS) {
      const value = (saved as Record<string, unknown>)[field];
      if (typeof value === 'string') values[field] = value;
    }
  } catch {
    // Private mode or a corrupt/old value: fall back to env defaults.
  }
  return values;
}

/** FIELD_KEYS is the allow-list; the password is not part of FormValues. */
function saveForm(values: FormValues): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        Object.fromEntries(FIELD_KEYS.map((field) => [field, values[field]])),
      ),
    );
  } catch {
    // Persistence is a convenience; never block connecting.
  }
}

function normalized(values: FormValues): FormValues {
  return Object.fromEntries(
    FIELD_KEYS.map((field) => [field, values[field].trim()]),
  ) as FormValues;
}

function optional(value: string): string | undefined {
  return value === '' ? undefined : value;
}

interface DemoFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  placeholder?: string;
  autoComplete?: string;
}

function DemoField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoComplete,
}: DemoFieldProps) {
  return (
    <label className="demo-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
    </label>
  );
}

export function App() {
  const [form, setForm] = useState<FormValues>(loadForm);
  const [password, setPassword] = useState(
    () => env.VITE_RD_PASSWORD ?? '',
  );
  const [active, setActive] = useState<RustDeskSessionConfig | null>(null);
  const [status, setStatus] = useState<RustDeskStatusEvent>({
    status: 'idle',
  });
  const [peerInfo, setPeerInfo] = useState<PeerInfo | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const update = (field: keyof FormValues, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const connect = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const values = normalized(form);
    if (!values.server || !values.id) {
      setFormError('Server and Device ID are required.');
      return;
    }
    saveForm(values);
    setForm(values);
    setFormError(null);
    setStatus({ status: 'connecting' });
    setPeerInfo(null);
    const decoderSimd = decoderSimdFromUrl();
    setActive({
      server: values.server,
      serverKey: optional(values.serverKey),
      relayServer: optional(values.relayServer),
      id: values.id,
      password: password === '' ? undefined : password,
      assetBaseUrl: optional(values.assetBaseUrl),
      ...(decoderSimd === undefined ? {} : { decoderSimd }),
    });
    // The viewer's config snapshot keeps the password; the form does not.
    setPassword('');
  };

  const closeViewer = (): void => {
    setActive(null);
  };

  return (
    <main className="demo">
      <header className="demo-header">
        <h1>rustdesk-web-react</h1>
        <p>Embed a RustDesk session in your own React admin.</p>
      </header>

      {active ? (
        <section className="viewer-panel">
          <div className="viewer-head">
            <span data-demo-status={status.status}>
              status: <strong>{status.status}</strong>
            </span>
            {peerInfo ? (
              <span className="viewer-peer">
                {peerInfo.username || 'unknown'}@{peerInfo.hostname} ·{' '}
                {peerInfo.platform} · RustDesk {peerInfo.version}
              </span>
            ) : null}
            <button
              id="rd-close"
              type="button"
              className="demo-button secondary"
              onClick={closeViewer}
            >
              Change settings
            </button>
          </div>
          <Suspense
            fallback={<p className="demo-note">Loading viewer…</p>}
          >
            <RustDeskViewer
              {...active}
              autoConnect
              onStatusChange={setStatus}
              onPeerInfo={setPeerInfo}
            />
          </Suspense>
        </section>
      ) : (
        <form className="demo-form" onSubmit={connect}>
          <DemoField
            id="rd-server"
            label="Server (host:port)"
            value={form.server}
            onChange={(value) => update('server', value)}
            placeholder="127.0.0.1:12116"
          />
          <DemoField
            id="rd-server-key"
            label="Server Key (hbbs public key, base64; self-hosted)"
            value={form.serverKey}
            onChange={(value) => update('serverKey', value)}
          />
          <DemoField
            id="rd-relay"
            label="Relay Server (optional)"
            value={form.relayServer}
            onChange={(value) => update('relayServer', value)}
            placeholder="empty uses RelayResponse / hbbs +3"
          />
          <DemoField
            id="rd-id"
            label="Device ID"
            value={form.id}
            onChange={(value) => update('id', value)}
          />
          <DemoField
            id="rd-password"
            label="Password (leave empty to use the viewer prompt; not saved)"
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete="off"
          />
          <DemoField
            id="rd-asset-base"
            label="Asset Base URL (same-origin; empty uses the default)"
            value={form.assetBaseUrl}
            onChange={(value) => update('assetBaseUrl', value)}
            placeholder={DEFAULT_ASSET_BASE}
          />

          {formError ? (
            <p className="demo-error" role="alert">
              {formError}
            </p>
          ) : null}

          <div className="demo-actions">
            <button id="rd-connect" type="submit" className="demo-button">
              Connect
            </button>
            <span className="demo-note">
              Non-password fields are remembered in this browser. The password
              is never stored.
            </span>
          </div>
        </form>
      )}
    </main>
  );
}
