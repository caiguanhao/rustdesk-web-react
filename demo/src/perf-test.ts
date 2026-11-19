// P5-3 browser performance check, driven by tests/e2e/perf.spec.ts.
//
// Measures page-start to first decoded/drawn frame, decoder initialization,
// and 1280x720 decode+draw FPS with the real VP9/ogv path. The fixture is a
// synthetic testsrc2 keyframe (not remote content); network/peer first-frame
// latency is covered by the real-device/final-acceptance checkpoints. Memory
// is measured by the Playwright test through CDP after forced GC.
import {
  PERF_FRAMES,
  PERF_WARMUP_FRAMES,
  VP9_PERF_FIXTURE,
} from '../../test-fixtures/vp9-perf';
import {
  bytesFromBase64,
  createCheckDecoder,
  drawVp9Frame,
  measureFps,
  mountRenderer,
  setStatus,
} from './check-harness';

export interface PerfResult {
  fixture: { name: string; width: number; height: number };
  usingWebGL: boolean;
  /** Milestones relative to navigation start (performance.now()). */
  firstFrameAtMs: number;
  decoderStartupMs: number;
  firstFrameDrawMs: number;
  fps: number;
  frames: number;
  warmupFrames: number;
  released: number;
}

declare global {
  interface Window {
    perfTestReady?: boolean;
    runPerfTest?: () => Promise<PerfResult>;
  }
}

async function runPerfTest(): Promise<PerfResult> {
  setStatus('loading decoder…');
  const decoderStarted = performance.now();
  const decoder = await createCheckDecoder();
  const decoderStartupMs = performance.now() - decoderStarted;

  const stage = document.getElementById('stage');
  if (!stage) throw new Error('perf test: #stage is missing');
  const { renderer } = mountRenderer(stage);

  let released = 0;
  const bytes = bytesFromBase64(VP9_PERF_FIXTURE.keyframeBase64);
  const draw = (): Promise<unknown> =>
    drawVp9Frame(renderer, decoder, bytes, () => {
      released += 1;
    });

  setStatus('first frame…');
  const firstStarted = performance.now();
  await draw();
  const firstFrameDrawMs = performance.now() - firstStarted;
  const firstFrameAtMs = performance.now();

  setStatus('measuring FPS…');
  const { fps } = await measureFps(draw, PERF_FRAMES, PERF_WARMUP_FRAMES);

  setStatus(`done: ${fps.toFixed(1)} fps`);
  return {
    fixture: {
      name: VP9_PERF_FIXTURE.name,
      width: VP9_PERF_FIXTURE.width,
      height: VP9_PERF_FIXTURE.height,
    },
    usingWebGL: renderer.usingWebGL,
    firstFrameAtMs,
    decoderStartupMs,
    firstFrameDrawMs,
    fps,
    frames: PERF_FRAMES,
    warmupFrames: PERF_WARMUP_FRAMES,
    released,
  };
}

window.runPerfTest = runPerfTest;
window.perfTestReady = true;
