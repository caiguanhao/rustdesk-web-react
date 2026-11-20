/**
 * P4-4 demo: the embeddable viewer behind a small connection form.
 *
 * Non-credential fields are remembered in localStorage; the password stays in
 * React state only. Hash mode posts { serverKey, password, salt } to the
 * dev/preview-only `/api/rustdesk/credential` endpoint, which returns
 * `{ passwordHash, serverKeyVerifier }` (h1 + a fresh signed envelope). The
 * fetched credential stays in React state and is shown in read-only fields and
 * the generated snippet. Submitting mounts a fresh <RustDeskViewer>
 * (lazy-loaded, so the form does not pay for the protocol/renderer graph) with
 * a snapshot of the form; "Change settings" unmounts/disposes it.
 */
import {
  lazy,
  Suspense,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  PeerInfo,
  RustDeskSessionConfig,
  RustDeskStatusEvent,
} from 'rustdesk-web-react/core';

const env = import.meta.env;
const STORAGE_KEY = 'rustdesk-web-react.demo.form.v1';
/** Mirrors `DEFAULT_ASSET_BASE_URL`; the viewer applies it when empty. */
const DEFAULT_ASSET_BASE = '/rustdesk-assets/';

type CredentialMode = 'password' | 'hash';

const FIELD_KEYS = [
  'credentialMode',
  'server',
  'serverKey',
  'salt',
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
    credentialMode: env.VITE_RD_CREDENTIAL_MODE === 'hash' ? 'hash' : 'password',
    server: env.VITE_RD_SERVER ?? '',
    serverKey: env.VITE_RD_KEY ?? '',
    salt: env.VITE_RD_SALT ?? '',
    relayServer: env.VITE_RD_RELAY ?? '',
    id: env.VITE_RD_ID ?? '',
    assetBaseUrl: env.VITE_RD_ASSET_BASE ?? '',
  };
}

function modeFromValue(value: string): CredentialMode {
  return value === 'hash' ? 'hash' : 'password';
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
    values.credentialMode = modeFromValue(values.credentialMode);
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

interface HashCredential {
  passwordHash: string;
  publicKey: string;
  verifier: string;
}

function viewerExample(
  values: FormValues,
  mode: CredentialMode,
  hashCredential: HashCredential | null,
): string {
  const server = values.server || 'rd.example.com';
  const id = values.id || '123456789';
  const lines = [
    "import { RustDeskViewer } from 'rustdesk-web-react';",
    '',
    'export function RemotePanel() {',
    '  return (',
    '    <RustDeskViewer',
    `      server={${JSON.stringify(server)}}`,
  ];

  if (mode === 'hash') {
    const publicKey =
      hashCredential?.publicKey || '<verifier Ed25519 public key>';
    const verifier =
      hashCredential?.verifier || '<base64 signature || message>';
    const passwordHash =
      hashCredential?.passwordHash ||
      '<base64 SHA256(password || salt)>';
    lines.push(
      '      serverKeyVerifier={{',
      `        publicKey: ${JSON.stringify(publicKey)},`,
      `        verifier: ${JSON.stringify(verifier)},`,
      '      }}',
      `      passwordHash={${JSON.stringify(passwordHash)}}`,
    );
  } else {
    lines.push(
      `      serverKey={${JSON.stringify(values.serverKey || '<hbbs base64 public key>')}}`,
      '      password="<device password>"',
    );
  }

  if (values.relayServer) {
    lines.push(`      relayServer={${JSON.stringify(values.relayServer)}}`);
  }
  lines.push(`      id={${JSON.stringify(id)}}`);
  if (values.assetBaseUrl) {
    lines.push(
      `      assetBaseUrl={${JSON.stringify(values.assetBaseUrl)}}`,
    );
  }
  lines.push('      autoConnect', '    />', '  );', '}', '');
  return lines.join('\n');
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
  readOnly?: boolean;
  hint?: ReactNode;
}

function DemoField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoComplete,
  readOnly = false,
  hint,
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
        readOnly={readOnly}
      />
      {hint ? <span className="demo-field-hint">{hint}</span> : null}
    </label>
  );
}

interface DemoTextareaProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  readOnly?: boolean;
}

function DemoTextarea({
  id,
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
  readOnly = false,
}: DemoTextareaProps) {
  return (
    <label className="demo-field" htmlFor={id}>
      <span>{label}</span>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        readOnly={readOnly}
      />
    </label>
  );
}

export function App() {
  const [form, setForm] = useState<FormValues>(loadForm);
  const [password, setPassword] = useState(
    () => env.VITE_RD_PASSWORD ?? '',
  );
  const [hashCredential, setHashCredential] =
    useState<HashCredential | null>(null);
  const [hashLoading, setHashLoading] = useState(false);
  const [hashError, setHashError] = useState<string | null>(null);
  const [active, setActive] = useState<RustDeskSessionConfig | null>(null);
  const mode = modeFromValue(form.credentialMode);
  const [status, setStatus] = useState<RustDeskStatusEvent>({
    status: 'idle',
  });
  const [peerInfo, setPeerInfo] = useState<PeerInfo | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const update = (field: keyof FormValues, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setFormError(null);
    if (field === 'credentialMode') {
      setHashError(null);
    }
    if (field === 'serverKey' || field === 'salt') {
      setHashCredential(null);
      setHashError(null);
    }
  };

  const updatePassword = (value: string): void => {
    setPassword(value);
    setFormError(null);
    setHashCredential(null);
    setHashError(null);
  };

  const prepareHashCredential = async (): Promise<void> => {
    const values = normalized(form);
    if (!values.serverKey) {
      setHashError('Server Key is required to build the verifier.');
      return;
    }
    if (password === '') {
      setHashError('Enter the device password first.');
      return;
    }
    if (!values.salt) {
      setHashError(
        'Password Salt is required. Copy salt = "..." from the controlled ' +
          "device's RustDesk.toml: macOS " +
          '~/Library/Preferences/com.carriez.RustDesk/RustDesk.toml; Linux ' +
          '~/.config/rustdesk/RustDesk.toml (root/service: ' +
          '/root/.config/rustdesk/RustDesk.toml).',
      );
      return;
    }

    setHashLoading(true);
    setHashError(null);
    try {
      const response = await fetch('/api/rustdesk/credential', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serverKey: values.serverKey,
          password,
          salt: values.salt,
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        passwordHash?: string;
        serverKeyVerifier?: { publicKey?: string; verifier?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      if (
        !payload.passwordHash ||
        !payload.serverKeyVerifier?.publicKey ||
        !payload.serverKeyVerifier.verifier
      ) {
        throw new Error('The demo API returned an incomplete credential.');
      }
      setHashCredential({
        passwordHash: payload.passwordHash,
        publicKey: payload.serverKeyVerifier.publicKey,
        verifier: payload.serverKeyVerifier.verifier,
      });
      setForm(values);
      saveForm(values);
    } catch (error) {
      setHashCredential(null);
      setHashError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setHashLoading(false);
    }
  };

  const connect = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const values = normalized(form);
    const selectedMode = modeFromValue(values.credentialMode);
    if (!values.server || !values.id) {
      setFormError('Server and Device ID are required.');
      return;
    }
    if (selectedMode === 'hash' && !hashCredential) {
      setFormError(
        'Click "Get passwordHash + serverKeyVerifier" first.',
      );
      return;
    }
    saveForm(values);
    setForm(values);
    setFormError(null);
    setHashError(null);
    setStatus({ status: 'connecting' });
    setPeerInfo(null);
    const decoderSimd = decoderSimdFromUrl();
    const base = {
      server: values.server,
      relayServer: optional(values.relayServer),
      id: values.id,
      assetBaseUrl: optional(values.assetBaseUrl),
      ...(decoderSimd === undefined ? {} : { decoderSimd }),
    };
    setActive(
      selectedMode === 'hash'
        ? {
            ...base,
            serverKeyVerifier: {
              publicKey: hashCredential!.publicKey,
              verifier: hashCredential!.verifier,
            },
            passwordHash: hashCredential!.passwordHash,
          }
        : {
            ...base,
            serverKey: optional(values.serverKey),
            password: password === '' ? undefined : password,
          },
    );
    // The viewer's config snapshot keeps the credential; the form does not.
    setPassword('');
  };

  const closeViewer = (): void => {
    setActive(null);
    setHashCredential(null);
    setHashError(null);
    setPassword('');
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
          <label className="demo-field" htmlFor="rd-credential-mode">
            <span>Credential mode</span>
            <select
              id="rd-credential-mode"
              value={form.credentialMode}
              onChange={(event) =>
                update('credentialMode', event.target.value)
              }
            >
              <option value="password">Plaintext password</option>
              <option value="hash">
                passwordHash + serverKeyVerifier
              </option>
            </select>
          </label>
          <DemoField
            id="rd-server"
            label="Server (host:port)"
            value={form.server}
            onChange={(value) => update('server', value)}
            placeholder="127.0.0.1:12116"
          />
          <DemoField
            id="rd-server-key"
            label={
              mode === 'password'
                ? 'Server Key (hbbs public key, base64; self-hosted)'
                : 'Server Key (hbbs public key; the demo API signs it into the verifier)'
            }
            value={form.serverKey}
            onChange={(value) => update('serverKey', value)}
          />
          <DemoField
            id="rd-password"
            label={
              mode === 'password'
                ? 'Password (leave empty to use the viewer prompt; not saved)'
                : 'Password (sent to the demo API to build h1; not saved)'
            }
            value={password}
            onChange={updatePassword}
            type="password"
            autoComplete="off"
          />
          {mode === 'hash' ? (
            <>
              <DemoField
                id="rd-salt"
                label="Password Salt (peer Hash.salt; used to build h1)"
                value={form.salt}
                onChange={(value) => update('salt', value)}
                hint={
                  <>
                    On the controlled device, copy <code>salt = "..."</code>{' '}
                    from <code>RustDesk.toml</code>. macOS:{' '}
                    <code>
                      ~/Library/Preferences/com.carriez.RustDesk/RustDesk.toml
                    </code>
                    ; Linux: <code>~/.config/rustdesk/RustDesk.toml</code>{' '}
                    (root/service:{' '}
                    <code>/root/.config/rustdesk/RustDesk.toml</code>).
                  </>
                }
              />
              <div className="demo-actions">
                <button
                  id="rd-get-credential"
                  type="button"
                  className="demo-button secondary"
                  onClick={() => void prepareHashCredential()}
                  disabled={hashLoading}
                >
                  {hashLoading
                    ? 'Preparing…'
                    : 'Get passwordHash + serverKeyVerifier'}
                </button>
                <span className="demo-note">
                  Calls the local demo API with the password; nothing is
                  persisted.
                </span>
              </div>
              {hashError ? (
                <p className="demo-error" role="alert">
                  {hashError}
                </p>
              ) : null}
              <DemoField
                id="rd-password-hash"
                label="Password Hash (returned by the demo API)"
                value={hashCredential?.passwordHash ?? ''}
                onChange={() => {}}
                readOnly
                placeholder="Fetched from /api/rustdesk/credential"
              />
              <DemoField
                id="rd-verifier-public-key"
                label="Verifier Public Key (returned by the demo API)"
                value={hashCredential?.publicKey ?? ''}
                onChange={() => {}}
                readOnly
                placeholder="Fetched from /api/rustdesk/credential"
              />
              <DemoTextarea
                id="rd-verifier"
                label="Verifier (returned by the demo API; contains the server key)"
                value={hashCredential?.verifier ?? ''}
                onChange={() => {}}
                readOnly
                rows={3}
                placeholder="Fetched from /api/rustdesk/credential"
              />
            </>
          ) : null}
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
              Non-credential fields are remembered in this browser. The
              password and fetched hash/verifier are never stored.
            </span>
          </div>
        </form>
      )}

      <section className="demo-code-panel">
        <h2>Example: &lt;RustDeskViewer /&gt;</h2>
        <pre className="demo-code">
          <code>{viewerExample(form, mode, hashCredential)}</code>
        </pre>
        <p className="demo-note">
          The password stays a placeholder. After “Get passwordHash +
          serverKeyVerifier”, hash mode shows the fetched values in the snippet;
          treat that snippet as a credential and do not share it.
        </p>
      </section>
    </main>
  );
}
