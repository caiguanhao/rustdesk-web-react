import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_ASSET_BASE_URL,
  OGV_RUNTIME_FILES,
  VERSION,
  assetUrl,
  resolveAssetBaseUrl,
} from 'rustdesk-web-react/core';

interface ManifestFile {
  name: string;
  role: string;
  bytes: number;
}

interface DecoderManifest {
  version: string;
  files: ManifestFile[];
}

interface OgvLoaderGlobal {
  base: string;
}

declare global {
  interface Window {
    OGVLoader?: OgvLoaderGlobal;
  }
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

async function fetchOk(url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response;
}

/** Load the real ogv loader (P2-1 will drive its decoder classes) and point it at `base`. */
async function loadOgvLoader(base: string, signal: AbortSignal): Promise<void> {
  if (!window.OGVLoader) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      const onAbort = () => script.remove();
      script.src = assetUrl(base, 'ogv.js');
      script.async = true;
      script.onload = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      script.onerror = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('ogv.js failed to load'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      document.head.append(script);
    });
  }
  if (!window.OGVLoader) {
    throw new Error('ogv.js loaded but window.OGVLoader is missing');
  }
  window.OGVLoader.base = base;
}

/**
 * P0-3 acceptance check: fetch the served manifest plus every runtime decoder
 * file from `assetBaseUrl`, compare sizes with the manifest (this catches stale
 * copies and SPA fallbacks that answer 200 with index.html), then load ogv.js
 * and verify `OGVLoader` exists with the right base.
 */
async function checkAssets(assetBaseUrl: string, signal: AbortSignal): Promise<AssetCheckResult> {
  const base = resolveAssetBaseUrl(assetBaseUrl);
  const manifestResponse = await fetchOk(assetUrl(base, 'manifest.json'), signal);
  const manifest = (await manifestResponse.json()) as DecoderManifest;
  const byName = new Map(manifest.files.map((file) => [file.name, file]));

  const files = await Promise.all(
    OGV_RUNTIME_FILES.map(async (name) => {
      const entry = byName.get(name);
      if (!entry) {
        throw new Error(`${name}: missing from manifest.json`);
      }
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
  const [assetBaseUrl, setAssetBaseUrl] = useState(DEFAULT_ASSET_BASE_URL);
  const [assetState, setAssetState] = useState<AssetCheckState>({ status: 'checking' });
  const abortRef = useRef<AbortController | null>(null);

  const runCheck = useCallback((base: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAssetState({ status: 'checking' });
    checkAssets(base, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setAssetState({ status: 'ok', result });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setAssetState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, []);

  useEffect(() => {
    runCheck(DEFAULT_ASSET_BASE_URL);
    return () => abortRef.current?.abort();
  }, [runCheck]);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '42rem' }}>
      <h1>rustdesk-web-react</h1>
      <p>Demo scaffold v{VERSION}. The connection form arrives in P1-9/P4-4.</p>

      <section>
        <h2>Decoder assets</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            runCheck(assetBaseUrl);
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
              <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                {assetState.result.files.map((file) => (
                  <li key={file.name}>
                    <code>{file.name}</code> — {file.bytes.toLocaleString()} bytes
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <p style={{ color: '#555', fontSize: '0.875rem' }}>
          Run <code>npm run copy-assets</code> if the files are missing; <code>npm run dev</code>{' '}
          copies them automatically.
        </p>
      </section>
    </main>
  );
}
