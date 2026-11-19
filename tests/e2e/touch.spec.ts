import { expect, test, type Page } from '@playwright/test';
import type { RecordedMouse } from '../../demo/src/input-test';
import type { TouchGesture } from '../../src/input/touch';

// P3-4 Playwright acceptance: real Chromium touch input via touchscreen.tap
// and CDP multi-touch. Real iPhone/Android behavior remains ⏳ 真机待验.

test.use({ hasTouch: true });

const messages = (page: Page): Promise<RecordedMouse[]> =>
  page.evaluate(() => window.inputTest?.messages ?? []);

const gestures = (page: Page): Promise<TouchGesture[]> =>
  page.evaluate(() => window.inputTest?.gestures ?? []);

const reset = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    window.inputTest?.clear();
    window.inputTest?.clearGestures();
  });
};

test('emulates mouse gestures and zooms locally', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/input-test.html');
  await page.waitForFunction(() => window.inputTest?.ready === true);
  const canvas = page.locator('#stage canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('touch test: canvas has no bounding box');
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  const dispatchTouch = (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    touchPoints: { id: number; x: number; y: number }[],
  ) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });

  await reset(page);
  await page.touchscreen.tap(center.x, center.y);
  await expect.poll(async () => (await messages(page)).length).toBe(3);
  expect((await messages(page)).map((event) => event.mask)).toEqual([
    0, 9, 10,
  ]);
  expect(await gestures(page)).toEqual(['tap']);

  // A different point also stays outside the 300 ms double-tap window.
  await reset(page);
  await page.touchscreen.tap(center.x + 60, center.y);
  await page.touchscreen.tap(center.x + 60, center.y);
  await expect.poll(async () => (await messages(page)).length).toBe(6);
  expect(
    (await messages(page)).filter((event) => event.mask === 9),
  ).toHaveLength(2);
  expect(await gestures(page)).toEqual(['tap', 'double-tap']);

  await reset(page);
  await dispatchTouch('touchStart', [{ id: 1, ...center }]);
  await page.waitForFunction(() =>
    window.inputTest?.gestures.includes('long-press'),
  );
  await dispatchTouch('touchEnd', []);
  await expect.poll(async () => (await messages(page)).length).toBe(3);
  expect((await messages(page)).map((event) => event.mask)).toEqual([0, 17, 18]);
  expect(await gestures(page)).toEqual(['long-press']);

  await reset(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await dispatchTouch('touchStart', [{ id: 1, ...center }]);
  await dispatchTouch('touchMove', [
    { id: 1, x: center.x + 60, y: center.y },
  ]);
  await dispatchTouch('touchEnd', []);
  await expect.poll(async () => (await messages(page)).length).toBe(4);
  expect((await messages(page)).map((event) => event.mask)).toEqual([
    0, 9, 8, 10,
  ]);
  expect(await gestures(page)).toEqual(['drag']);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await reset(page);
  await dispatchTouch('touchStart', [
    { id: 1, x: center.x - 50, y: center.y },
    { id: 2, x: center.x + 50, y: center.y },
  ]);
  await dispatchTouch('touchMove', [
    { id: 1, x: center.x - 100, y: center.y },
    { id: 2, x: center.x + 100, y: center.y },
  ]);
  await dispatchTouch('touchEnd', []);
  await expect.poll(async () => (await gestures(page)).includes('pinch')).toBe(
    true,
  );
  expect(await messages(page)).toEqual([]);
  expect(
    await page.evaluate(() => window.inputTest?.localZoom.scale),
  ).toBeGreaterThan(1);
  await page.evaluate(() => window.inputTest?.resetTouchZoom());

  await reset(page);
  await dispatchTouch('touchStart', [
    { id: 1, x: center.x - 20, y: center.y },
    { id: 2, x: center.x + 20, y: center.y },
  ]);
  await dispatchTouch('touchMove', [
    { id: 1, x: center.x - 20, y: center.y + 60 },
    { id: 2, x: center.x + 20, y: center.y + 60 },
  ]);
  await dispatchTouch('touchEnd', []);
  await expect
    .poll(async () => (await messages(page)).some((event) => event.mask === 3))
    .toBe(true);
  expect(await gestures(page)).toEqual(['scroll']);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await reset(page);
  await page.evaluate(() => {
    window.inputTest?.setTouchEnabled(false);
    // Synthetic compatibility mouse events would otherwise reach MouseInput.
    window.inputTest?.setMouseEnabled(false);
  });
  await page.touchscreen.tap(center.x, center.y);
  expect(await messages(page)).toEqual([]);
  await page.evaluate(() => {
    window.inputTest?.setTouchEnabled(true);
    window.inputTest?.setMouseEnabled(true);
  });

  await reset(page);
  await page.touchscreen.tap(10, center.y);
  expect(await messages(page)).toEqual([]);

  expect(errors).toEqual([]);
});
