/**
 * Lazy libsodium initialization.
 *
 * libsodium-wrappers is loaded with a dynamic import so it never enters the
 * first bundle; it is only needed once a connection starts. `ready` must be
 * awaited before any primitive is called.
 */
import { RustDeskError } from '../session/errors.js';

export type Sodium = typeof import('libsodium-wrappers').default;

let sodiumPromise: Promise<Sodium> | undefined;

export function loadSodium(): Promise<Sodium> {
  sodiumPromise ??= import('libsodium-wrappers')
    .then(async (module) => {
      const sodium = module.default;
      await sodium.ready;
      return sodium;
    })
    .catch((cause: unknown) => {
      // Allow a later connect to retry after a transient load failure.
      sodiumPromise = undefined;
      if (cause instanceof RustDeskError) throw cause;
      throw new RustDeskError('asset-load-failed', 'Failed to initialize libsodium', { cause });
    });
  return sodiumPromise;
}
