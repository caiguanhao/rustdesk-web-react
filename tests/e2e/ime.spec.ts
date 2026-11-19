import { expect, test, type Page } from '@playwright/test';
import type { RecordedKey } from '../../demo/src/input-test';

// P3-3 Playwright acceptance: hidden textarea contract, insertText, synthetic
// composition/paste and viewport notifications. Real iOS/Android IME remains
// ⏳ 真机待验.

const keys = (page: Page): Promise<RecordedKey[]> =>
  page.evaluate(() => window.inputTest?.keys ?? []);

const clearKeys = (page: Page): Promise<void> =>
  page.evaluate(() => window.inputTest?.clearKeys());

test('sends soft-keyboard/composition/paste text as Translate seq', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/input-test.html');
  await page.waitForFunction(() => window.inputTest?.ready === true);

  const textarea = page.locator('textarea');
  await expect(textarea).toHaveCount(1);
  await expect(textarea).toHaveCSS('width', '1px');
  await expect(textarea).toHaveCSS('height', '1px');
  await expect(textarea).toHaveCSS('opacity', '0');
  await expect(textarea).toHaveCSS('font-size', '16px');
  await expect(textarea).not.toHaveCSS('display', 'none');

  expect(await page.evaluate(() => window.inputTest?.focusIme())).toBe(true);
  expect(await page.evaluate(() => window.inputTest?.imeFocused)).toBe(true);

  await clearKeys(page);
  await page.keyboard.insertText('你好');
  expect((await keys(page)).at(-1)).toMatchObject({
    seq: '你好',
    mode: 2,
    down: true,
    press: false,
  });

  await clearKeys(page);
  await page.evaluate(() => {
    const element = document.querySelector('textarea');
    if (!element) throw new Error('missing textarea');
    element.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    element.dispatchEvent(
      new InputEvent('input', {
        data: '中',
        isComposing: true,
        bubbles: true,
      }),
    );
    element.dispatchEvent(
      new CompositionEvent('compositionend', {
        data: '中文',
        bubbles: true,
      }),
    );
  });
  expect((await keys(page)).map((event) => event.seq)).toEqual(['中文']);

  await clearKeys(page);
  const prevented = await page.evaluate(() => {
    const element = document.querySelector('textarea');
    if (!element) throw new Error('missing textarea');
    const data = new DataTransfer();
    data.setData('text/plain', '粘贴');
    const event = new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  expect((await keys(page)).at(-1)).toMatchObject({ seq: '粘贴', mode: 2 });

  await page.setViewportSize({ width: 500, height: 400 });
  await expect
    .poll(() => page.evaluate(() => window.inputTest?.viewport?.width))
    .toBe(500);

  await page.evaluate(() => window.inputTest?.setImeEnabled(false));
  expect(await page.evaluate(() => window.inputTest?.imeFocused)).toBe(false);
  expect(await page.evaluate(() => window.inputTest?.focusIme())).toBe(false);
  await clearKeys(page);
  await page.keyboard.insertText('x');
  expect(await keys(page)).toEqual([]);

  await page.evaluate(() => window.inputTest?.setImeEnabled(true));
  expect(await page.evaluate(() => window.inputTest?.focusIme())).toBe(true);
  await page.keyboard.insertText('z');
  expect((await keys(page)).at(-1)).toMatchObject({ seq: 'z', mode: 2 });

  // Physical keys still use Map mode while the IME textarea owns focus; the
  // keydown preventDefault stops the textarea from also emitting input/seq.
  await page.evaluate(() => window.inputTest?.setPlatform('Windows'));
  await clearKeys(page);
  await page.keyboard.press('KeyA');
  expect((await keys(page)).filter((event) => event.seq)).toEqual([]);
  expect((await keys(page)).map((event) => event.chr)).toEqual([30, 30]);

  await clearKeys(page);
  await page.keyboard.press('Backspace');
  expect((await keys(page)).filter((event) => event.seq)).toEqual([]);
  expect((await keys(page)).map((event) => event.chr)).toEqual([14, 14]);

  expect(errors).toEqual([]);
});
