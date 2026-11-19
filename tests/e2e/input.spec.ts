import { expect, test, type Page } from '@playwright/test';
import type { RecordedMouse } from '../../demo/src/input-test';

// P3-1 Playwright acceptance: real browser mouse events against a real
// VideoRenderer/letterboxed canvas, recording the exact RustDesk wire masks.
// This is not a substitute for real-device click/scroll verification.

const messages = (page: Page): Promise<RecordedMouse[]> =>
  page.evaluate(() => window.inputTest?.messages ?? []);

const clear = (page: Page): Promise<void> =>
  page.evaluate(() => window.inputTest?.clear());

test('forwards mouse masks/coordinates and suppresses local defaults', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/input-test.html');
  await page.waitForFunction(() => window.inputTest?.ready === true);

  const canvas = page.locator('#stage canvas');
  await expect(canvas).toBeVisible();
  let box = await canvas.boundingBox();
  if (!box) throw new Error('input test: canvas has no bounding box');
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // 64x64 frame scaled to 360x360 -> center is remote pixel (32,32).
  await page.mouse.move(center.x, center.y);
  expect((await messages(page)).at(-1)).toMatchObject({ mask: 0, x: 32, y: 32 });

  await clear(page);
  await page.mouse.down();
  await page.mouse.up();
  expect(await messages(page)).toMatchObject([
    { mask: 0, x: 32, y: 32 },
    { mask: 9, x: 0, y: 0 },
    { mask: 10, x: 0, y: 0 },
  ]);

  await clear(page);
  await page.mouse.dblclick(center.x, center.y);
  const doubleClick = await messages(page);
  expect(doubleClick.filter((event) => event.mask === 9)).toHaveLength(2);
  expect(doubleClick.filter((event) => event.mask === 10)).toHaveLength(2);

  await clear(page);
  await page.mouse.click(center.x, center.y, { button: 'right' });
  const rightClick = await messages(page);
  expect(rightClick.some((event) => event.mask === 17)).toBe(true);
  expect(rightClick.some((event) => event.mask === 18)).toBe(true);
  expect(
    await page.evaluate(() => window.inputTest?.lastContextMenuPrevented),
  ).toBe(true);

  await clear(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, 120);
  expect((await messages(page)).at(-1)).toMatchObject({
    mask: 3,
    x: 0,
    y: -1,
  });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await clear(page);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 80, center.y);
  await page.mouse.up();
  const drag = await messages(page);
  expect(drag.some((event) => event.mask === 9)).toBe(true);
  expect(drag.some((event) => event.mask === 8 && event.x === 63)).toBe(true);
  expect(drag.at(-1)).toMatchObject({ mask: 10, x: 0, y: 0 });

  // Black letterbox bars are outside the canvas and send nothing.
  await clear(page);
  await page.mouse.click(10, center.y);
  expect(await messages(page)).toEqual([]);

  // Portrait layout keeps mapping to the same frame pixel.
  await page.evaluate(() => window.inputTest?.setStageSize(360, 640));
  box = await canvas.boundingBox();
  if (!box) throw new Error('input test: portrait canvas has no bounding box');
  await clear(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const portrait = await messages(page);
  expect(portrait.at(-1)).toMatchObject({ mask: 10, x: 0, y: 0 });
  expect(
    portrait.some(
      (event) => event.mask === 0 && event.x === 32 && event.y === 32,
    ),
  ).toBe(true);

  expect(errors).toEqual([]);
});
