// Playwright canvas acceptance (P2-5), driven by tests/e2e/canvas.spec.ts.
// Decodes the pre-generated VP9 fixtures, draws them through VideoRenderer and
// returns pixel samples, letterbox geometry and FPS stats to the test.
import { VP9_FIXTURES } from '../../test-fixtures/vp9';
import {
  bytesFromBase64,
  createCheckDecoder,
  drawVp9Frame,
  measureFps,
  mountRenderer,
  readPixel,
  setStatus,
  snapshot,
  type CanvasSnapshot,
} from './check-harness';

const ITERATIONS = 60;

export interface CanvasFixtureResult {
  name: string;
  width: number;
  height: number;
  pixel: number[];
}

export interface CanvasCheckResult {
  usingWebGL: boolean;
  released: number;
  frames: CanvasFixtureResult[];
  first: CanvasSnapshot;
  portrait: CanvasSnapshot;
  /** 64x64 decode+draw microbenchmark, not remote-video throughput. */
  fps: number;
  fpsFrames: number;
}

declare global {
  interface Window {
    canvasTestReady?: boolean;
    runCanvasTest?: () => Promise<CanvasCheckResult>;
  }
}

async function runCanvasTest(): Promise<CanvasCheckResult> {
  setStatus('loading decoder…');
  const decoder = await createCheckDecoder();
  const stage = document.getElementById('stage');
  if (!stage) throw new Error('canvas test: #stage is missing');
  stage.style.width = '640px';
  stage.style.height = '360px';
  stage.replaceChildren();

  const { canvas, renderer } = mountRenderer(stage);

  let released = 0;
  const drawFrame = (value: Uint8Array) =>
    drawVp9Frame(renderer, decoder, value, () => {
      released += 1;
    });

  setStatus('drawing fixtures…');
  const encoded = VP9_FIXTURES.map((entry) => ({
    entry,
    bytes: bytesFromBase64(entry.keyframeBase64),
  }));
  const frames: CanvasFixtureResult[] = [];
  for (const { entry, bytes } of encoded) {
    const size = await drawFrame(bytes);
    frames.push({
      name: entry.name,
      width: size.width,
      height: size.height,
      pixel: await readPixel(canvas),
    });
  }
  const first = snapshot(canvas, stage, renderer);

  stage.style.width = '360px';
  stage.style.height = '640px';
  renderer.resize();
  const portrait = snapshot(canvas, stage, renderer);

  const fpsFixture = encoded[0];
  if (!fpsFixture) throw new Error('canvas test: no VP9 fixtures');
  setStatus('measuring FPS…');
  const { fps } = await measureFps(
    () => drawFrame(fpsFixture.bytes),
    ITERATIONS,
  );

  setStatus(`done: ${frames.length} fixtures, ${fps.toFixed(1)} fps`);
  return {
    usingWebGL: renderer.usingWebGL,
    released,
    frames,
    first,
    portrait,
    fps,
    fpsFrames: ITERATIONS,
  };
}

window.runCanvasTest = runCanvasTest;
window.canvasTestReady = true;
