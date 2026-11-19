// Headless-browser check for P2-1/P2-3, driven by scripts/check-decoders.mjs.
// Decodes one real 64x64 VP9 keyframe (ffmpeg libvpx-vp9, lossless) 200 times
// with both WASM builds and recycles every frame, then decodes it once more and
// draws it through yuv-canvas to verify the letterboxed renderer geometry.
import { VP9_FIXTURES } from '../../test-fixtures/vp9';
import { VideoRenderer } from '../../src/media/renderer';
import { frameSize } from '../../src/media/vp9-decoder';
import {
  bytesFromBase64,
  createCheckDecoder,
  readPixel,
  setStatus,
  snapshot,
} from './check-harness';

const RED_FRAME = VP9_FIXTURES.find((frame) => frame.name === 'red-64x64');
if (!RED_FRAME) throw new Error('test-fixtures/vp9.ts is missing red-64x64');

const FRAME = bytesFromBase64(RED_FRAME.keyframeBase64);
const ITERATIONS = 200;

type Mode = 'simd' | 'non-simd' | 'auto';

function heapUsed(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } })
    .memory;
  return memory?.usedJSHeapSize ?? null;
}

function collectGarbage(): void {
  (globalThis as unknown as { gc?: () => void }).gc?.();
}

async function runDecoderCheck(mode: Mode): Promise<unknown> {
  const forced = mode === 'auto' ? undefined : mode === 'simd';
  collectGarbage();
  const heapBefore = heapUsed();
  setStatus(`loading ${mode} decoder…`);

  const decoder = await createCheckDecoder(forced);
  const simd = decoder.simd;

  let decoded = 0;
  let width = 0;
  let height = 0;
  for (let index = 0; index < ITERATIONS; index += 1) {
    const frame = await decoder.decode(FRAME);
    if (!frame) continue;
    decoded += 1;
    const size = frameSize(frame);
    width = size?.width ?? 0;
    height = size?.height ?? 0;
    decoder.recycle(frame);
  }
  decoder.dispose();
  collectGarbage();
  const heapAfter = heapUsed();
  setStatus(`${mode} decoder: ${decoded}/${ITERATIONS}`);

  return {
    mode,
    simd,
    decoded,
    iterations: ITERATIONS,
    width,
    height,
    heapBefore,
    heapAfter,
    heapDelta: heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null,
  };
}

async function runRendererCheck(): Promise<unknown> {
  setStatus('checking renderer…');

  const decoder = await createCheckDecoder();
  const container = document.createElement('div');
  container.style.position = 'relative';
  container.style.width = '320px';
  container.style.height = '200px';
  container.style.background = '#000';
  const canvas = document.createElement('canvas');
  container.append(canvas);
  document.body.append(container);

  const renderer = new VideoRenderer(canvas, container, { webGL: true });
  let released = 0;
  try {
    const frame = await decoder.decode(FRAME);
    const size = frame ? frameSize(frame) : null;
    if (!frame || !size) throw new Error('renderer check: frame did not decode');

    renderer.draw(frame, () => {
      released += 1;
      decoder.recycle(frame);
    });
    const first = snapshot(canvas, container, renderer);
    const pixel = await readPixel(canvas);
    const rect = canvas.getBoundingClientRect();
    const centerRemote = renderer.toRemote(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );

    container.style.width = '200px';
    container.style.height = '320px';
    renderer.resize();
    const second = snapshot(canvas, container, renderer);

    setStatus('renderer check done');
    return {
      frame: size,
      usingWebGL: renderer.usingWebGL,
      released,
      first,
      second,
      centerRemote,
      pixel,
    };
  } finally {
    renderer.dispose();
    decoder.dispose();
    container.remove();
  }
}

(window as unknown as { runDecoderCheck: typeof runDecoderCheck }).runDecoderCheck =
  runDecoderCheck;
(window as unknown as { runRendererCheck: typeof runRendererCheck }).runRendererCheck =
  runRendererCheck;
(window as unknown as { decoderCheckReady: boolean }).decoderCheckReady = true;
