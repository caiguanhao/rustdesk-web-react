// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RustDeskError } from '../src/session/errors';
import { Vp9Decoder, type OgvLoader, type Vp9Frame } from '../src/media/vp9-decoder';
import { DEFAULT_ASSET_BASE_URL } from '../src/assets';

// P2-1 unit coverage: class selection/fallback, worker options, serialized
// decoding, recycling, rebuild-after-close and load/init timeouts. The real
// WASM builds are exercised by scripts/check-decoders.mjs in headless Chrome.

const mocks = vi.hoisted(() => ({ simdResult: true }));
vi.mock('wasm-feature-detect', () => ({
  simd: () => Promise.resolve(mocks.simdResult),
}));

interface Behavior {
  fail?: boolean;
  initHangs?: boolean;
  neverLoads?: boolean;
  delayMs?: number;
}

class FakeDecoder {
  frameBuffer: Vp9Frame | null = null;
  active = 0;
  maxActive = 0;
  readonly recycled: Vp9Frame[] = [];
  closed = false;

  constructor(private readonly behavior: Behavior = {}) {}

  init(callback: () => void): void {
    if (this.behavior.initHangs) return;
    queueMicrotask(callback);
  }

  processFrame(_data: ArrayBuffer, callback: (ok: boolean) => void): void {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    setTimeout(() => {
      this.active -= 1;
      if (this.behavior.fail) {
        callback(false);
        return;
      }
      this.frameBuffer = { width: 64, height: 64 };
      callback(true);
    }, this.behavior.delayMs ?? 0);
  }

  recycleFrame(frame: Vp9Frame): void {
    this.recycled.push(frame);
  }

  close(): void {
    this.closed = true;
  }
}

interface LoadCall {
  name: string;
  options: { worker: boolean; threading: boolean };
}

function installLoader(
  behavior: Behavior = {},
  failNames: string[] = [],
): { calls: LoadCall[]; instances: FakeDecoder[] } {
  const calls: LoadCall[] = [];
  const instances: FakeDecoder[] = [];
  const loader: OgvLoader = {
    base: '',
    loadClass(name, callback, options) {
      calls.push({ name, options });
      if (behavior.neverLoads) return;
      if (failNames.includes(name)) throw new Error(`load ${name} failed`);
      callback(() => {
        const decoder = new FakeDecoder(behavior);
        instances.push(decoder);
        return Promise.resolve(decoder);
      });
    },
  };
  window.OGVLoader = loader;
  return { calls, instances };
}

const frame = Uint8Array.from([1, 2, 3]);

afterEach(() => {
  delete window.OGVLoader;
});

describe('Vp9Decoder', () => {
  it('loads the SIMD worker with threading disabled', async () => {
    const { calls, instances } = installLoader();
    const decoder = await Vp9Decoder.create({
      simd: true,
      assetBaseUrl: DEFAULT_ASSET_BASE_URL,
    });
    expect(decoder.simd).toBe(true);
    expect(calls).toEqual([
      { name: 'OGVDecoderVideoVP9SIMDW', options: { worker: true, threading: false } },
    ]);

    const decoded = await decoder.decode(frame);
    expect(decoded).toMatchObject({ width: 64, height: 64 });
    decoder.recycle(decoded!);
    expect(instances[0]?.recycled).toEqual([decoded]);
    decoder.dispose();
    expect(instances[0]?.closed).toBe(true);
  });

  it('loads the mandatory non-SIMD worker', async () => {
    const { calls } = installLoader();
    const decoder = await Vp9Decoder.create({
      simd: false,
      assetBaseUrl: DEFAULT_ASSET_BASE_URL,
    });
    expect(decoder.simd).toBe(false);
    expect(calls[0]?.name).toBe('OGVDecoderVideoVP9W');
  });

  it('falls back to non-SIMD when auto-detected SIMD fails', async () => {
    const { calls } = installLoader({}, ['OGVDecoderVideoVP9SIMDW']);
    const decoder = await Vp9Decoder.create({ assetBaseUrl: DEFAULT_ASSET_BASE_URL });
    expect(decoder.simd).toBe(false);
    expect(calls.map((call) => call.name)).toEqual([
      'OGVDecoderVideoVP9SIMDW',
      'OGVDecoderVideoVP9W',
    ]);
  });

  it('reports a load timeout', async () => {
    installLoader({ neverLoads: true });
    await expect(
      Vp9Decoder.create({ simd: true, timeoutMs: 20, assetBaseUrl: DEFAULT_ASSET_BASE_URL }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('reports an init timeout', async () => {
    installLoader({ initHangs: true });
    await expect(
      Vp9Decoder.create({ simd: false, timeoutMs: 20, assetBaseUrl: DEFAULT_ASSET_BASE_URL }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('surfaces a class load error when SIMD is forced', async () => {
    installLoader({}, ['OGVDecoderVideoVP9SIMDW']);
    await expect(
      Vp9Decoder.create({ simd: true, assetBaseUrl: DEFAULT_ASSET_BASE_URL }),
    ).rejects.toMatchObject({ code: 'asset-load-failed' });
  });

  it('serializes overlapping decode calls', async () => {
    const { instances } = installLoader({ delayMs: 10 });
    const decoder = await Vp9Decoder.create({
      simd: false,
      assetBaseUrl: DEFAULT_ASSET_BASE_URL,
    });
    const results = await Promise.all([decoder.decode(frame), decoder.decode(frame)]);
    expect(results).toHaveLength(2);
    expect(instances[0]?.maxActive).toBe(1);
  });

  it('returns null when the decoder rejects a frame', async () => {
    installLoader({ fail: true });
    const decoder = await Vp9Decoder.create({
      simd: false,
      assetBaseUrl: DEFAULT_ASSET_BASE_URL,
    });
    await expect(decoder.decode(frame)).resolves.toBeNull();
  });

  it('rebuilds a decoder after close and disposes idempotently', async () => {
    const { instances } = installLoader();
    const decoder = await Vp9Decoder.create({
      simd: false,
      assetBaseUrl: DEFAULT_ASSET_BASE_URL,
    });
    await decoder.rebuild();
    expect(instances).toHaveLength(2);
    expect(instances[0]?.closed).toBe(true);
    expect(instances[1]?.closed).toBe(false);

    decoder.dispose();
    decoder.dispose();
    expect(instances[1]?.closed).toBe(true);
    let error: unknown;
    try {
      await decoder.decode(frame);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RustDeskError);
    expect((error as RustDeskError).code).toBe('aborted');
  });
});
