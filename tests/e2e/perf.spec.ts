import { expect, test, type CDPSession } from '@playwright/test';
import type { PerfResult } from '../../demo/src/perf-test';
import {
  PERF_FRAMES,
  PERF_WARMUP_FRAMES,
  VP9_PERF_FIXTURE,
} from '../../test-fixtures/vp9-perf';

// P5-3 browser performance acceptance. Measures page-start to first drawn
// frame, decoder startup, 1280x720 VP9 decode+draw FPS and page JS heap growth
// (CDP after forced GC) through a real browser. The fixture is a synthetic
// testsrc2 keyframe, so this is pipeline performance, not remote-network
// first-frame latency (P5-5/real devices). The JS and asset gzip budgets are
// enforced by `npm run check-size`; their measured values are recorded in
// docs/PERFORMANCE.md.

async function metric(cdp: CDPSession, name: string): Promise<number> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((entry) => entry.name === name)?.value ?? Number.NaN;
}

async function heapUsed(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  return metric(cdp, 'JSHeapUsedSize');
}

// Engineering floors with wide margins over the recorded local run; size
// budgets are enforced separately by `npm run check-size`.
const MIN_FPS = 30;
const MAX_FIRST_FRAME_MS = 2_000;
const MAX_DECODER_STARTUP_MS = 1_000;
const MAX_FIRST_DRAW_MS = 500;
const MAX_HEAP_GROWTH_BYTES = 16 * 1024 * 1024;

test('records 720p startup, first frame, decode FPS and bounded memory', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/perf-test.html');
  await page.waitForFunction(() => window.perfTestReady === true);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  const heapBefore = await heapUsed(cdp);

  const result: PerfResult = await page.evaluate(() => window.runPerfTest!());

  const heapAfter = await heapUsed(cdp);
  const heapGrowth = heapAfter - heapBefore;

  expect(result.fixture).toEqual({
    name: VP9_PERF_FIXTURE.name,
    width: VP9_PERF_FIXTURE.width,
    height: VP9_PERF_FIXTURE.height,
  });
  expect(result.frames).toBe(PERF_FRAMES);
  expect(result.warmupFrames).toBe(PERF_WARMUP_FRAMES);
  expect(result.released).toBe(PERF_FRAMES + PERF_WARMUP_FRAMES + 1);
  expect(result.fps).toBeGreaterThan(MIN_FPS);
  expect(result.firstFrameAtMs).toBeLessThan(MAX_FIRST_FRAME_MS);
  expect(result.decoderStartupMs).toBeLessThan(MAX_DECODER_STARTUP_MS);
  expect(result.firstFrameDrawMs).toBeLessThan(MAX_FIRST_DRAW_MS);
  expect(heapGrowth).toBeLessThan(MAX_HEAP_GROWTH_BYTES);

  console.log(
    `perf: first frame ${result.firstFrameAtMs.toFixed(0)} ms after navigation, ` +
      `decoder ready ${result.decoderStartupMs.toFixed(0)} ms, ` +
      `first draw ${result.firstFrameDrawMs.toFixed(0)} ms, ` +
      `${result.fps.toFixed(1)} fps (${result.fixture.width}x${result.fixture.height}), ` +
      `heap ${(heapBefore / 1048576).toFixed(1)}→${(heapAfter / 1048576).toFixed(1)} MiB ` +
      `(+${(heapGrowth / 1048576).toFixed(1)}), ` +
      `WebGL=${result.usingWebGL}`,
  );
  expect(errors).toEqual([]);
});
