import { expect, test, type Page } from '@playwright/test';
import type { RecordedKey } from '../../demo/src/input-test';

// P3-2 Playwright acceptance: real browser keyboard events through the
// Map-mode encoder. Desktop shortcuts and IME remain real-device checks.

const keys = (page: Page): Promise<RecordedKey[]> =>
  page.evaluate(() => window.inputTest?.keys ?? []);

const clearKeys = (page: Page): Promise<void> =>
  page.evaluate(() => window.inputTest?.clearKeys());

const setPlatform = (page: Page, platform: string): Promise<void> =>
  page.evaluate((value) => window.inputTest?.setPlatform(value), platform);

test('maps physical keys, modifiers, repeat and specials', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/input-test.html');
  await page.waitForFunction(() => window.inputTest?.ready === true);

  await setPlatform(page, 'Windows');
  await clearKeys(page);
  await page.keyboard.press('KeyA');
  expect(await keys(page)).toMatchObject([
    { down: true, press: false, chr: 30, mode: 1, modifiers: [] },
    { down: false, press: false, chr: 30, mode: 1, modifiers: [] },
  ]);

  await clearKeys(page);
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Shift');
  expect((await keys(page)).map((event) => event.chr)).toEqual([42, 30, 30, 42]);

  await clearKeys(page);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Control');
  expect((await keys(page)).map((event) => event.chr)).toEqual([29, 46, 46, 29]);

  await clearKeys(page);
  await page.keyboard.down('KeyA');
  await page.keyboard.down('KeyA');
  await page.keyboard.up('KeyA');
  expect((await keys(page)).map((event) => event.down)).toEqual([
    true,
    true,
    false,
  ]);

  await setPlatform(page, 'Mac OS');
  await clearKeys(page);
  await page.keyboard.press('KeyA');
  expect((await keys(page)).map((event) => event.chr)).toEqual([0, 0]);

  await setPlatform(page, 'Windows');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => window.inputTest?.lastKeyDownPrevented)).toBe(
    true,
  );

  await clearKeys(page);
  const composing = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {
      code: 'KeyA',
      key: 'a',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(composing).toBe(false);
  expect(await keys(page)).toEqual([]);

  await setPlatform(page, 'Windows');
  await clearKeys(page);
  await page.evaluate(() => window.inputTest?.sendCtrlAltDel());
  expect((await keys(page)).at(-1)).toMatchObject({
    control_key: 100,
    down: true,
    press: false,
    mode: 0,
  });

  await setPlatform(page, 'Linux');
  await clearKeys(page);
  await page.evaluate(() => window.inputTest?.sendCtrlAltDel());
  expect((await keys(page)).at(-1)).toMatchObject({
    control_key: 5,
    press: true,
    modifiers: [1, 4],
    mode: 0,
  });
  await page.evaluate(() => window.inputTest?.sendLockScreen());
  expect((await keys(page)).at(-1)).toMatchObject({
    control_key: 101,
    down: true,
    mode: 0,
  });

  await page.evaluate(() => window.inputTest?.setKeyboardEnabled(false));
  await clearKeys(page);
  await page.keyboard.press('KeyA');
  expect(await keys(page)).toEqual([]);
  await page.evaluate(() => window.inputTest?.setKeyboardEnabled(true));
  await page.keyboard.press('KeyA');
  expect(await keys(page)).toHaveLength(2);

  expect(errors).toEqual([]);
});
