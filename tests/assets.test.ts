import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from '../assets/ogv/manifest.json';
import {
  AssetUrlError,
  DEFAULT_ASSET_BASE_URL,
  OGV_RUNTIME_FILES,
  assetUrl,
  resolveAssetBaseUrl,
} from '../src/assets';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// P0-3: the file names exported to the library must match the manifest that
// the copy/verify scripts consume. Sizes, SHA-256 and stray-file checks live in
// scripts/lib/ogv-assets.mjs, exercised below through `check-size.mjs`.
describe('ogv decoder assets', () => {
  it('keeps the exported runtime file list in sync with manifest.json', () => {
    const runtime = manifest.files.filter((file) => file.role !== 'license');
    expect(runtime.map((file) => file.name).sort()).toEqual([...OGV_RUNTIME_FILES].sort());
    expect(runtime.map((file) => file.role).sort()).toEqual([
      'decoder-js',
      'decoder-js',
      'decoder-wasm',
      'decoder-wasm',
      'loader',
      'worker',
    ]);
    // The non-SIMD fallback is mandatory (iOS < 16.4); never ship SIMD only.
    expect(OGV_RUNTIME_FILES.some((name) => name.endsWith('-vp9-wasm.wasm'))).toBe(true);
    expect(OGV_RUNTIME_FILES.some((name) => name.endsWith('-vp9-simd-wasm.wasm'))).toBe(true);
  });

  it('passes the shared verifier (sizes, SHA-256, no stray files)', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/check-size.mjs'], {
        cwd: repoRoot,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});

describe('resolveAssetBaseUrl', () => {
  const page = 'https://admin.example.com/app/index.html';

  it('resolves the default base against the page URL', () => {
    expect(resolveAssetBaseUrl(DEFAULT_ASSET_BASE_URL, page)).toBe(
      'https://admin.example.com/rustdesk-assets/',
    );
  });

  it('resolves a relative base and adds a trailing slash', () => {
    expect(resolveAssetBaseUrl('decoders', page)).toBe(
      'https://admin.example.com/app/decoders/',
    );
  });

  it('accepts an absolute same-origin base and normalises query/hash', () => {
    expect(resolveAssetBaseUrl('https://admin.example.com/static/ogv/?v=1#x', page)).toBe(
      'https://admin.example.com/static/ogv/',
    );
  });

  it('treats an empty string as the default base', () => {
    expect(resolveAssetBaseUrl('  ', page)).toBe('https://admin.example.com/rustdesk-assets/');
  });

  it('rejects a cross-origin base, because workers/WASM need same-origin', () => {
    try {
      resolveAssetBaseUrl('https://cdn.example.net/ogv/', page);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AssetUrlError);
      expect((error as AssetUrlError).reason).toBe('cross-origin');
    }
  });

  it('rejects non-http(s) bases', () => {
    try {
      resolveAssetBaseUrl('file:///tmp/ogv/', page);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AssetUrlError).reason).toBe('unsupported-protocol');
    }
  });

  it('requires an explicit base outside the browser', () => {
    try {
      resolveAssetBaseUrl();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AssetUrlError).reason).toBe('no-base-url');
    }
  });

  it('reports invalid base URLs distinctly', () => {
    try {
      resolveAssetBaseUrl('/ogv/', 'not a url');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AssetUrlError).reason).toBe('invalid-url');
    }
  });
});

describe('assetUrl', () => {
  it('joins a flat asset name under the resolved base', () => {
    expect(assetUrl('/rustdesk-assets/', 'ogv.js', 'https://admin.example.com/app/')).toBe(
      'https://admin.example.com/rustdesk-assets/ogv.js',
    );
  });
});
