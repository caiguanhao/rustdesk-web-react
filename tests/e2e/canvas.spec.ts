import { expect, test } from '@playwright/test';
import type { CanvasCheckResult } from '../../demo/src/canvas-test';
import { VP9_FIXTURES } from '../../test-fixtures/vp9';

// P2-5: real browser canvas acceptance. The page decodes pre-generated VP9
// fixtures (test-fixtures/vp9.json), draws them through VideoRenderer and
// returns pixel samples, letterbox geometry and FPS stats.

test('decodes VP9 fixtures and renders a non-blank letterboxed canvas', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/canvas-test.html');
  await page.waitForFunction(() => window.canvasTestReady === true);
  const result: CanvasCheckResult = await page.evaluate(() =>
    window.runCanvasTest!(),
  );

  expect(result.frames).toHaveLength(VP9_FIXTURES.length);
  expect(
    result.frames.map(({ name, width, height }) => ({ name, width, height })),
  ).toEqual(
    VP9_FIXTURES.map(({ name, width, height }) => ({ name, width, height })),
  );

  // Pixel samples prove the canvas is non-blank and the second fixture
  // actually replaced the first frame.
  const red = result.frames[0]!;
  const green = result.frames[1]!;
  expect(red.pixel[0]!).toBeGreaterThan(200);
  expect(red.pixel[1]!).toBeLessThan(80);
  expect(red.pixel[2]!).toBeLessThan(80);
  expect(green.pixel[0]!).toBeLessThan(80);
  expect(green.pixel[1]!).toBeGreaterThan(100);
  expect(green.pixel[2]!).toBeLessThan(80);
  expect(green.pixel[1]!).toBeGreaterThan(green.pixel[0]! + 50);

  // 64x64 in a 640x360 stage -> 360x360 CSS, centered horizontally.
  expect(result.first.layout).toMatchObject({
    width: 64,
    height: 64,
    cssWidth: 360,
    cssHeight: 360,
    offsetX: 140,
    offsetY: 0,
  });
  // Portrait container keeps the square frame square and letterboxes vertically.
  expect(result.portrait.layout).toMatchObject({
    width: 64,
    height: 64,
    cssWidth: 360,
    cssHeight: 360,
    offsetX: 0,
    offsetY: 140,
  });

  // The browser's own box matches the computed letterbox after the resize.
  const canvas = page.locator('#stage canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeCloseTo(360, 0);
  expect(box!.height).toBeCloseTo(360, 0);

  expect(result.released).toBe(result.frames.length + result.fpsFrames);
  expect(result.fpsFrames).toBeGreaterThan(0);
  expect(result.fps).toBeGreaterThan(0);
  expect(errors).toEqual([]);

  console.log(
    `canvas: ${result.frames.length} fixtures, ${result.fps.toFixed(1)} fps ` +
      `64x64 microbenchmark (${result.usingWebGL ? 'WebGL' : 'software'})`,
  );
});
