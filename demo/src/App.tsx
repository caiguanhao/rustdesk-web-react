import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_ASSET_BASE_URL,
  OGV_RUNTIME_FILES,
  RustDeskError,
  VERSION,
  assetUrl,
  resolveAssetBaseUrl,
  type PeerInfo,
} from 'rustdesk-web-react/core';
import type { RelayConnection } from '../../src/protocol/connection';
import type { LoginFlow } from '../../src/protocol/login';

interface ManifestFile {
  name: string;
  role: string;
  bytes: number;
}

interface DecoderManifest {
  version: string;
  files: ManifestFile[];
}

interface AssetCheckResult {
  base: string;
  version: string;
  files: { name: string; bytes: number }[];
}

type AssetCheckState =
  | { status: 'checking' }
  | { status: 'ok'; result: AssetCheckResult }
  | { status: 'error'; message: string };

interface PasswordPrompt {
  retry: boolean;
  detail?: string;
}

interface ConnectError {
  code: string;
  message: string;
}

const env = import.meta.env;

async function fetchOk(url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response;
}

/** Load the real ogv loader and point it at `base`. */
async function loadOgvLoader(base: string, signal: AbortSignal): Promise<void> {
  const { loadOgvJs } = await import('../../src/media/vp9-decoder');
  await loadOgvJs(base, 15_000, signal);
}

async function checkAssets(assetBaseUrl: string, signal: AbortSignal): Promise<AssetCheckResult> {
  const base = resolveAssetBaseUrl(assetBaseUrl);
  const manifestResponse = await fetchOk(assetUrl(base, 'manifest.json'), signal);
  const manifest = (await manifestResponse.json()) as DecoderManifest;
  const byName = new Map(manifest.files.map((file) => [file.name, file]));

  const files = await Promise.all(
    OGV_RUNTIME_FILES.map(async (name) => {
      const entry = byName.get(name);
      if (!entry) throw new Error(`${name}: missing from manifest.json`);
      const response = await fetchOk(new URL(name, base).href, signal);
      const bytes = (await response.arrayBuffer()).byteLength;
      if (bytes !== entry.bytes) {
        throw new Error(`${name}: ${bytes} bytes, expected ${entry.bytes}`);
      }
      return { name, bytes };
    }),
  );

  await loadOgvLoader(base, signal);
  return { base, version: manifest.version, files };
}

export function App() {
  const [assetBaseUrl, setAssetBaseUrl] = useState(
    env.VITE_RD_ASSET_BASE || DEFAULT_ASSET_BASE_URL,
  );
  const [assetState, setAssetState] = useState<AssetCheckState>({ status: 'checking' });
  const assetAbortRef = useRef<AbortController | null>(null);

  const [server, setServer] = useState(env.VITE_RD_SERVER ?? '');
  const [serverKey, setServerKey] = useState(env.VITE_RD_KEY ?? '');
  const [relayServer, setRelayServer] = useState(env.VITE_RD_RELAY ?? '');
  const [deviceId, setDeviceId] = useState(env.VITE_RD_ID ?? '');
  const [password, setPassword] = useState(env.VITE_RD_PASSWORD ?? '');
  const [status, setStatus] = useState('idle');
  const [busy, setBusy] = useState(false);
  const [peerInfo, setPeerInfo] = useState<PeerInfo | null>(null);
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [error, setError] = useState<ConnectError | null>(null);

  const connectionRef = useRef<RelayConnection | null>(null);
  const flowRef = useRef<LoginFlow | null>(null);
  const connectAbortRef = useRef<AbortController | null>(null);

  const cleanupConnection = useCallback(() => {
    connectAbortRef.current?.abort();
    connectAbortRef.current = null;
    flowRef.current?.dispose();
    flowRef.current = null;
    connectionRef.current?.close();
    connectionRef.current = null;
  }, []);

  useEffect(() => cleanupConnection, [cleanupConnection]);

  const runAssetCheck = useCallback((base: string) => {
    assetAbortRef.current?.abort();
    const controller = new AbortController();
    assetAbortRef.current = controller;
    setAssetState({ status: 'checking' });
    checkAssets(base, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setAssetState({ status: 'ok', result });
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setAssetState({
          status: 'error',
          message: failure instanceof Error ? failure.message : String(failure),
        });
      },
    );
  }, []);

  useEffect(() => {
    runAssetCheck(DEFAULT_ASSET_BASE_URL);
    return () => assetAbortRef.current?.abort();
  }, [runAssetCheck]);

  const connect = async (): Promise<void> => {
    cleanupConnection();
    setError(null);
    setPeerInfo(null);
    setPasswordPrompt(null);
    setPermissions([]);
    setStatus('connecting');
    setBusy(true);

    if (!server.trim() || !deviceId.trim()) {
      setError({ code: 'invalid-config', message: 'Server and Device ID are required.' });
      setStatus('error');
      setBusy(false);
      return;
    }

    const controller = new AbortController();
    connectAbortRef.current = controller;
    try {
      // Keep protobuf/libsodium out of the initial demo bundle.
      const [{ connectRelay }, { LoginFlow }] = await Promise.all([
        import('../../src/protocol/connection'),
        import('../../src/protocol/login'),
      ]);
      const connection = await connectRelay({
        server: server.trim(),
        peerId: deviceId.trim(),
        serverKey: serverKey.trim() || undefined,
        relayServer: relayServer.trim() || undefined,
        secure: window.location.protocol === 'https:',
        signal: controller.signal,
        openTimeoutMs: 12_000,
        responseTimeoutMs: 12_000,
        securingTimeoutMs: 18_000,
      });
      connectionRef.current = connection;

      const flow = new LoginFlow(connection, {
        peerId: deviceId.trim(),
        password: password || undefined,
        loginTimeoutMs: 60_000,
        onStatus: (event) => {
          setStatus(event.status);
          if (event.status === 'password-required') {
            setPasswordPrompt({ retry: event.retry, detail: event.detail });
          }
        },
        onPermission: (change) => {
          setPermissions((current) => [
            ...current,
            `${change.permission}: ${change.enabled ? 'on' : 'off'}`,
          ]);
        },
      });
      flowRef.current = flow;
      const info = await flow.start(undefined, controller.signal);
      setPeerInfo(info);
      setPasswordPrompt(null);
      setStatus('connected');
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof RustDeskError) {
        setError({ code: failure.code, message: failure.message });
      } else {
        setError({
          code: 'unknown',
          message: failure instanceof Error ? failure.message : String(failure),
        });
      }
      setStatus('error');
    } finally {
      setBusy(false);
    }
  };

  const retryLogin = (): void => {
    setPasswordPrompt(null);
    try {
      flowRef.current?.login(password);
    } catch (failure) {
      setError({
        code: failure instanceof RustDeskError ? failure.code : 'unknown',
        message: failure instanceof Error ? failure.message : String(failure),
      });
    }
  };

  const disconnect = (): void => {
    cleanupConnection();
    setPeerInfo(null);
    setPasswordPrompt(null);
    setPermissions([]);
    setStatus('idle');
    setError(null);
  };

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        maxWidth: '48rem',
        margin: '0 auto',
      }}
    >
      <h1>rustdesk-web-react</h1>
      <p>Demo v{VERSION}. Video/input wiring arrives in later tasks.</p>

      <section style={{ marginBottom: '2rem' }}>
        <h2>Connect</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
          style={{ display: 'grid', gap: '0.5rem' }}
        >
          <label>
            Server (host:port)
            <input
              value={server}
              onChange={(event) => setServer(event.target.value)}
              placeholder="127.0.0.1:12116"
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <label>
            Server Key (hbbs public key, base64)
            <input
              value={serverKey}
              onChange={(event) => setServerKey(event.target.value)}
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <label>
            Relay Server (optional)
            <input
              value={relayServer}
              onChange={(event) => setRelayServer(event.target.value)}
              placeholder="uses RelayResponse / hbbs +3"
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <label>
            Device ID
            <input
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="off"
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button type="submit" disabled={busy}>
              Connect
            </button>
            <button type="button" onClick={disconnect}>
              Disconnect
            </button>
            <span>
              status: <strong>{status}</strong>
            </span>
          </div>
        </form>

        {passwordPrompt && (
          <div style={{ marginTop: '0.75rem', color: '#8a5a00' }}>
            Password required{passwordPrompt.retry ? ' (previous password was rejected)' : ''}
            {passwordPrompt.detail ? `: ${passwordPrompt.detail}` : ''}
            <div style={{ marginTop: '0.25rem' }}>
              <button type="button" onClick={retryLogin}>
                Retry login
              </button>
            </div>
          </div>
        )}

        {error && (
          <p style={{ color: '#b00020' }}>
            {error.code}: {error.message}
          </p>
        )}

        {permissions.length > 0 && (
          <p>permissions: {permissions.join(', ')}</p>
        )}

        {peerInfo && (
          <div style={{ marginTop: '0.75rem', color: '#0b7a29' }}>
            <p>
              Connected to {peerInfo.username || '(unknown user)'}@{peerInfo.hostname} (
              {peerInfo.platform}, RustDesk {peerInfo.version})
            </p>
            <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
              {peerInfo.displays.map((display, index) => (
                <li key={index}>
                  display {index}: {display.width}×{display.height} {display.name}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section>
        <h2>Decoder assets</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            runAssetCheck(assetBaseUrl);
          }}
          style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}
        >
          <label htmlFor="asset-base">Asset Base URL</label>
          <input
            id="asset-base"
            value={assetBaseUrl}
            onChange={(event) => setAssetBaseUrl(event.target.value)}
            style={{ flex: 1, fontFamily: 'monospace' }}
          />
          <button type="submit">Check</button>
        </form>

        <div style={{ marginTop: '0.75rem' }}>
          {assetState.status === 'checking' && <p>Loading decoder assets…</p>}
          {assetState.status === 'error' && (
            <p style={{ color: '#b00020' }}>Asset check failed: {assetState.message}</p>
          )}
          {assetState.status === 'ok' && (
            <div>
              <p style={{ color: '#0b7a29' }}>
                ✓ ogv.js {assetState.result.version}: all {assetState.result.files.length} files
                served from <code>{assetState.result.base}</code>; loader ready
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
