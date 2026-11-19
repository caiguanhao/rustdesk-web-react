/**
 * ogv.js VP9 decoder wrapper.
 *
 * Loads `ogv.js` from `assetBaseUrl` (same-origin, as required by workers and
 * WASM), picks the SIMD or non-SIMD VP9 decoder with `wasm-feature-detect`,
 * and runs it in a worker with `threading: false` (SharedArrayBuffer is not
 * available on iOS Safari). If the SIMD build fails, auto-detection retries
 * the non-SIMD build.
 *
 * ogv's `close()` is a no-op, so a decoder cannot be reused after a
 * resolution change or WebGL context loss; `rebuild()` discards the old
 * instance and creates a fresh worker. Callers must pass every decoded frame
 * to `recycle()` after drawing so the worker reuses its YUV buffers.
 */
import { simd } from 'wasm-feature-detect';
import {
  DEFAULT_ASSET_BASE_URL,
  assetUrl,
  resolveAssetBaseUrl,
} from '../assets.js';
import { RustDeskError } from '../session/errors.js';

const DEFAULT_DECODER_TIMEOUT_MS = 15_000;

export interface Vp9DecoderOptions {
  /** Same-origin decoder asset directory (default `/rustdesk-assets/`). */
  assetBaseUrl?: string;
  /** Force SIMD/non-SIMD; omit to feature-detect (with non-SIMD fallback). */
  simd?: boolean;
  /** Load/construct/init budget; default 15 s. */
  timeoutMs?: number;
}

/** ogv's YUV frame format (subset used for sizing). */
export interface Vp9FrameFormat {
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number;
}

/**
 * Opaque YUV frame returned by ogv; the renderer owns the plane layout.
 * Real ogv frames carry their size in `format.displayWidth/displayHeight`
 * (plus `y`/`u`/`v` planes); the optional top-level size is for synthetic
 * frames in tests.
 */
export interface Vp9Frame {
  width?: number;
  height?: number;
  format?: Vp9FrameFormat;
  [key: string]: unknown;
}

export interface FrameSize {
  width: number;
  height: number;
}

/** Display size of an ogv frame, preferring `format` over synthetic fields. */
export function frameSize(frame: Vp9Frame): FrameSize | null {
  const width = frame.format?.displayWidth ?? frame.format?.width ?? frame.width;
  const height =
    frame.format?.displayHeight ?? frame.format?.height ?? frame.height;
  return width && height ? { width, height } : null;
}

export function sameSize(a: FrameSize | null, b: FrameSize | null): boolean {
  if (!a || !b) return a === b;
  return a.width === b.width && a.height === b.height;
}

interface OgvDecoder {
  frameBuffer: Vp9Frame | null;
  init(callback: () => void): void;
  processFrame(data: ArrayBuffer, callback: (ok: boolean) => void): void;
  recycleFrame(frame: Vp9Frame): void;
  close(): void;
}

type OgvDecoderConstructor = (options: {
  videoFormat: Record<string, unknown>;
}) => Promise<OgvDecoder>;

export interface OgvLoader {
  base: string;
  loadClass(
    name: string,
    callback: (decoderClass: OgvDecoderConstructor) => void,
    options: { worker: boolean; threading: boolean },
  ): void;
}

declare global {
  interface Window {
    OGVLoader?: OgvLoader;
  }
}

function asRustDeskError(operation: string, cause: unknown): RustDeskError {
  if (cause instanceof RustDeskError) return cause;
  return new RustDeskError('asset-load-failed', operation, { cause });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RustDeskError('timeout', `${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let loaderPromise: Promise<OgvLoader> | undefined;

function abortError(): RustDeskError {
  return new RustDeskError('aborted', 'ogv.js load was aborted');
}

/** Inject ogv.js once (shared by every decoder). */
function injectOgv(
  base: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OgvLoader> {
  const existing = typeof window === 'undefined' ? undefined : window.OGVLoader;
  if (existing) {
    return signal?.aborted ? Promise.reject(abortError()) : Promise.resolve(existing);
  }
  if (loaderPromise) {
    if (!signal) return loaderPromise;
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(abortError());
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      loaderPromise!.then(
        (loader) => {
          signal.removeEventListener('abort', abort);
          resolve(loader);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }
  if (typeof document === 'undefined') {
    return Promise.reject(
      new RustDeskError('asset-load-failed', 'VP9 decoding requires a browser'),
    );
  }

  loaderPromise = new Promise<OgvLoader>((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const onAbort = (): void => {
      fail(abortError());
    };
    const fail = (error: RustDeskError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      script.remove();
      loaderPromise = undefined;
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new RustDeskError('timeout', `ogv.js did not load within ${timeoutMs} ms`));
    }, timeoutMs);
    if (signal?.aborted) {
      fail(abortError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    script.onload = () => {
      if (settled) return;
      const loader = window.OGVLoader;
      if (!loader) {
        fail(
          new RustDeskError(
            'asset-load-failed',
            'ogv.js loaded but did not expose OGVLoader',
          ),
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(loader);
    };
    script.onerror = () => {
      fail(new RustDeskError('asset-load-failed', 'Failed to load ogv.js'));
    };
    try {
      script.src = assetUrl(base, 'ogv.js');
    } catch (cause) {
      fail(asRustDeskError('Invalid decoder asset URL', cause));
      return;
    }
    script.async = true;
    document.head.append(script);
  });
  return loaderPromise;
}

/**
 * Load ogv.js and point `OGVLoader.base` at `base`. Exported for the demo's
 * asset check; decoders call it through `Vp9Decoder.create`.
 */
export async function loadOgvJs(
  base: string,
  timeoutMs = DEFAULT_DECODER_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<OgvLoader> {
  const resolved = resolveAssetBaseUrl(base);
  const loader = await injectOgv(resolved, timeoutMs, signal);
  loader.base = resolved;
  return loader;
}

function loadDecoderClass(
  loader: OgvLoader,
  useSimd: boolean,
  timeoutMs: number,
): Promise<OgvDecoderConstructor> {
  const name = useSimd ? 'OGVDecoderVideoVP9SIMDW' : 'OGVDecoderVideoVP9W';
  return withTimeout(
    new Promise<OgvDecoderConstructor>((resolve, reject) => {
      try {
        loader.loadClass(
          name,
          (decoderClass) => {
            if (!decoderClass) {
              reject(
                new RustDeskError(
                  'asset-load-failed',
                  `ogv.js did not provide ${name}`,
                ),
              );
              return;
            }
            resolve(decoderClass);
          },
          { worker: true, threading: false },
        );
      } catch (cause) {
        reject(asRustDeskError(`Failed to load ${name}`, cause));
      }
    }),
    timeoutMs,
    `Loading ${name}`,
  );
}

async function instantiateDecoder(
  decoderClass: OgvDecoderConstructor,
  timeoutMs: number,
): Promise<OgvDecoder> {
  let decoder: OgvDecoder;
  try {
    decoder = await withTimeout(
      decoderClass({ videoFormat: {} }),
      timeoutMs,
      'Creating the VP9 decoder',
    );
  } catch (cause) {
    throw asRustDeskError('Failed to create the VP9 decoder', cause);
  }
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        try {
          decoder.init(resolve);
        } catch (cause) {
          reject(asRustDeskError('Failed to initialize the VP9 decoder', cause));
        }
      }),
      timeoutMs,
      'Initializing the VP9 decoder',
    );
  } catch (error) {
    // Do not leak a worker whose init never completed.
    try {
      decoder.close();
    } catch {
      // best effort
    }
    throw error;
  }
  return decoder;
}

async function createWith(
  loader: OgvLoader,
  useSimd: boolean,
  timeoutMs: number,
): Promise<OgvDecoder> {
  const decoderClass = await loadDecoderClass(loader, useSimd, timeoutMs);
  return instantiateDecoder(decoderClass, timeoutMs);
}

export class Vp9Decoder {
  readonly simd: boolean;

  private readonly loader: OgvLoader;
  private readonly timeoutMs: number;
  private decoder: OgvDecoder;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private constructor(
    decoder: OgvDecoder,
    simd: boolean,
    loader: OgvLoader,
    timeoutMs: number,
  ) {
    this.decoder = decoder;
    this.simd = simd;
    this.loader = loader;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Load and initialize a decoder. Auto-detection prefers SIMD and falls back
   * to the mandatory non-SIMD build if the SIMD worker fails.
   */
  static async create(options: Vp9DecoderOptions = {}): Promise<Vp9Decoder> {
    const base = resolveAssetBaseUrl(options.assetBaseUrl ?? DEFAULT_ASSET_BASE_URL);
    const timeoutMs = options.timeoutMs ?? DEFAULT_DECODER_TIMEOUT_MS;
    const loader = await loadOgvJs(base, timeoutMs);

    let useSimd = options.simd;
    if (useSimd === undefined) {
      try {
        useSimd = await simd();
      } catch {
        useSimd = false;
      }
    }

    try {
      const decoder = await createWith(loader, useSimd, timeoutMs);
      return new Vp9Decoder(decoder, useSimd, loader, timeoutMs);
    } catch (error) {
      if (useSimd && options.simd === undefined) {
        // Browsers sometimes advertise SIMD but fail inside the worker.
        const decoder = await createWith(loader, false, timeoutMs);
        return new Vp9Decoder(decoder, false, loader, timeoutMs);
      }
      throw error;
    }
  }

  /**
   * Decode one encoded VP9 frame. Calls are serialized: `processFrame` is
   * documented as sync-or-async and must never overlap. Resolves `null` when
   * the decoder rejects the frame (request a keyframe).
   */
  decode(data: Uint8Array): Promise<Vp9Frame | null> {
    if (this.disposed) {
      return Promise.reject(new RustDeskError('aborted', 'VP9 decoder was disposed'));
    }
    const run = this.queue.then(() => this.process(data));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Return a decoded frame to the worker after drawing it. */
  recycle(frame: Vp9Frame): void {
    if (this.disposed) return;
    try {
      this.decoder.recycleFrame(frame);
    } catch {
      // Recycling is best-effort; a dead worker must not break the session.
    }
  }

  /**
   * Recreate the worker. ogv's close() is a no-op and buffers cannot be reused
   * across resolution changes or WebGL context loss.
   */
  async rebuild(): Promise<void> {
    if (this.disposed) {
      throw new RustDeskError('aborted', 'VP9 decoder was disposed');
    }
    await this.queue;
    this.decoder.close();
    const decoder = await createWith(this.loader, this.simd, this.timeoutMs);
    if (this.disposed) {
      decoder.close();
      throw new RustDeskError('aborted', 'VP9 decoder was disposed');
    }
    this.decoder = decoder;
  }

  /** Drop this decoder; a new `Vp9Decoder` is required afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.decoder.close();
    } catch {
      // close() is a no-op in ogv 1.8.6; ignore failures.
    }
  }

  private process(data: Uint8Array): Promise<Vp9Frame | null> {
    return new Promise<Vp9Frame | null>((resolve, reject) => {
      if (this.disposed) {
        reject(new RustDeskError('aborted', 'VP9 decoder was disposed'));
        return;
      }
      // processFrame may retain the buffer; give it a standalone copy.
      const copy = data.slice();
      try {
        this.decoder.processFrame(copy.buffer as ArrayBuffer, (ok) => {
          if (this.disposed || !ok) {
            resolve(null);
            return;
          }
          resolve(this.decoder.frameBuffer ?? null);
        });
      } catch (cause) {
        reject(
          new RustDeskError('protocol-error', 'VP9 decode failed', { cause }),
        );
      }
    });
  }
}
