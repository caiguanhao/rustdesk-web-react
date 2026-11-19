// Headless-browser check for P2-1, driven by scripts/check-decoders.mjs.
// Decodes one real 64x64 VP9 keyframe (ffmpeg libvpx-vp9, lossless) 200 times
// with both WASM builds and recycles every frame.
import { DEFAULT_ASSET_BASE_URL } from 'rustdesk-web-react/core';
import { Vp9Decoder } from '../../src/media/vp9-decoder';

// ffmpeg -f lavfi -i color=c=red:size=64x64:rate=10 -frames:v 1 \
//   -c:v libvpx-vp9 -lossless 1 -f ivf frame.ivf
const FRAME_BASE64 =
  'gkmDQgAD8AP2ADgkHBgAAAAgAAB4uf///I14Ax////7PyHD////2yMAzNYhIAA==';

const FRAME = Uint8Array.from(atob(FRAME_BASE64), (char) => char.charCodeAt(0));
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
  const status = document.getElementById('status');
  const forced = mode === 'auto' ? undefined : mode === 'simd';
  collectGarbage();
  const heapBefore = heapUsed();
  if (status) status.textContent = `loading ${mode} decoder…`;

  const decoder = await Vp9Decoder.create({
    simd: forced,
    assetBaseUrl: DEFAULT_ASSET_BASE_URL,
    timeoutMs: 20_000,
  });
  const simd = decoder.simd;

  let decoded = 0;
  let width = 0;
  let height = 0;
  for (let index = 0; index < ITERATIONS; index += 1) {
    const frame = await decoder.decode(FRAME);
    if (!frame) continue;
    decoded += 1;
    width = frame.width;
    height = frame.height;
    decoder.recycle(frame);
  }
  decoder.dispose();
  collectGarbage();
  const heapAfter = heapUsed();
  if (status) status.textContent = `${mode} decoder: ${decoded}/${ITERATIONS}`;

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

(window as unknown as { runDecoderCheck: typeof runDecoderCheck }).runDecoderCheck =
  runDecoderCheck;
(window as unknown as { decoderCheckReady: boolean }).decoderCheckReady = true;
