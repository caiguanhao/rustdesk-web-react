/**
 * Static decoder assets and URL helpers.
 *
 * The library ships no bundled WASM: host apps copy `assets/ogv/` into their
 * own public directory (`rustdesk-react copy-assets`) and pass that location as
 * `assetBaseUrl`. Workers and WASM must be served from the same origin as the
 * page, so `resolveAssetBaseUrl` rejects cross-origin bases instead of letting
 * the decoder fail later with an opaque worker error.
 *
 * Only file names live here; sizes, hashes and licenses are recorded once in
 * `assets/ogv/manifest.json` and verified by `scripts/check-size.mjs`.
 */

/** Default location produced by `npm run copy-assets` in the demo. */
export const DEFAULT_ASSET_BASE_URL = '/rustdesk-assets/';

/**
 * Runtime files fetched from `assetBaseUrl`. Both VP9 decoder flavours are
 * mandatory: the non-SIMD build is the fallback for iOS < 16.4.
 */
export const OGV_RUNTIME_FILES = [
  'ogv.js',
  'ogv-worker-video.js',
  'ogv-decoder-video-vp9-wasm.js',
  'ogv-decoder-video-vp9-wasm.wasm',
  'ogv-decoder-video-vp9-simd-wasm.js',
  'ogv-decoder-video-vp9-simd-wasm.wasm',
] as const;

export type OgvRuntimeFile = (typeof OGV_RUNTIME_FILES)[number];

export type AssetUrlErrorReason =
  | 'no-base-url'
  | 'invalid-url'
  | 'unsupported-protocol'
  | 'cross-origin';

export class AssetUrlError extends Error {
  readonly reason: AssetUrlErrorReason;

  constructor(reason: AssetUrlErrorReason, message: string) {
    super(message);
    this.name = 'AssetUrlError';
    this.reason = reason;
  }
}

function documentBaseUrl(): string | undefined {
  return typeof document === 'undefined' ? undefined : document.baseURI;
}

/**
 * Resolve `assetBaseUrl` against the page URL (or an explicit `baseUrl`) and
 * return it with a trailing slash, as ogv.js concatenates file names directly.
 *
 * @throws {AssetUrlError} when no base is available, the URL cannot be parsed,
 *   the protocol is not http(s), or the result is cross-origin.
 */
export function resolveAssetBaseUrl(
  assetBaseUrl: string = DEFAULT_ASSET_BASE_URL,
  baseUrl?: string,
): string {
  const base = baseUrl ?? documentBaseUrl();
  if (!base) {
    throw new AssetUrlError(
      'no-base-url',
      'Cannot resolve assetBaseUrl outside a browser; pass an absolute baseUrl.',
    );
  }

  let baseOrigin: string;
  try {
    baseOrigin = new URL(base).origin;
  } catch {
    throw new AssetUrlError('invalid-url', `Invalid base URL: ${base}`);
  }

  const candidate =
    assetBaseUrl.trim() === '' ? DEFAULT_ASSET_BASE_URL : assetBaseUrl;
  let resolved: URL;
  try {
    resolved = new URL(candidate, base);
  } catch {
    throw new AssetUrlError('invalid-url', `Invalid assetBaseUrl: ${candidate}`);
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new AssetUrlError(
      'unsupported-protocol',
      `assetBaseUrl must use http(s), got ${resolved.protocol}`,
    );
  }
  if (resolved.origin !== baseOrigin) {
    throw new AssetUrlError(
      'cross-origin',
      `assetBaseUrl must be same-origin as the page (${baseOrigin}), got ${resolved.origin}`,
    );
  }

  if (!resolved.pathname.endsWith('/')) {
    resolved.pathname = `${resolved.pathname}/`;
  }
  resolved.search = '';
  resolved.hash = '';
  return resolved.href;
}

/** Absolute URL of one decoder asset under `assetBaseUrl`. */
export function assetUrl(
  assetBaseUrl: string,
  fileName: string,
  baseUrl?: string,
): string {
  return new URL(fileName, resolveAssetBaseUrl(assetBaseUrl, baseUrl)).href;
}
