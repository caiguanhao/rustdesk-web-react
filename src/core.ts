/**
 * Framework-agnostic entry point (`rustdesk-web-react/core`).
 *
 * This module must never import React. It is safe to load in a Web Worker or
 * a Node test: browser-only helpers (`assets.ts`) are pure URL functions.
 */
export { VERSION } from './version.js';
export {
  AssetUrlError,
  DEFAULT_ASSET_BASE_URL,
  OGV_RUNTIME_FILES,
  assetUrl,
  resolveAssetBaseUrl,
} from './assets.js';
export type { AssetUrlErrorReason, OgvRuntimeFile } from './assets.js';

export { RustDeskError } from './session/errors.js';
export type { RustDeskErrorCode } from './session/errors.js';
export type { ImageQuality, RustDeskSessionConfig } from './session/options.js';
export type { DisplayInfo, PeerInfo } from './session/peer-info.js';
export type {
  RustDeskStatus,
  RustDeskStatusEvent,
  SessionStats,
} from './session/state.js';

export { RustDeskSession } from './session/RustDeskSession.js';
export type {
  RustDeskSessionDeps,
  RustDeskSessionEvents,
  SessionInputTargets,
  SessionVideoDecoder,
} from './session/RustDeskSession.js';
export type { RemoteClipboardEvent } from './input/clipboard.js';
export type {
  InputPolicy,
  InputPolicyTargets,
  PermissionChange,
  PermissionEvent,
  PermissionName,
  PermissionSnapshot,
  SessionPermissions,
} from './session/permissions.js';
export type { VideoSink } from './media/video-pipeline.js';
export type { Vp9Frame } from './media/vp9-decoder.js';
