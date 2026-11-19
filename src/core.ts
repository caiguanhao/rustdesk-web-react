// Framework-agnostic entry point (`rustdesk-web-react/core`). Placeholder
// until P4-1 adds RustDeskSession.
export { VERSION } from './version.js';
export {
  AssetUrlError,
  DEFAULT_ASSET_BASE_URL,
  OGV_RUNTIME_FILES,
  assetUrl,
  resolveAssetBaseUrl,
} from './assets.js';
export type { AssetUrlErrorReason, OgvRuntimeFile } from './assets.js';
