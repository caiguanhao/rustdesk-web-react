/**
 * Public React entry point (`rustdesk-web-react`).
 *
 * React stays a peer dependency: this bundle imports `react`/`react/jsx-runtime`
 * but never embeds it. `./core` remains React-free for non-React consumers.
 */
export * from './core.js';
export { RustDeskViewer } from './react/RustDeskViewer.js';
export type {
  PasswordPrompt,
  RustDeskViewerLabels,
  RustDeskViewerProps,
  RustDeskViewerRef,
} from './react/RustDeskViewer.js';
export { useRustDeskSession } from './react/useRustDeskSession.js';
export type {
  UseRustDeskSessionOptions,
  UseRustDeskSessionResult,
} from './react/useRustDeskSession.js';
