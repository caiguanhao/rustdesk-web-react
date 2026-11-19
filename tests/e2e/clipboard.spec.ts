import { expect, test, type Page } from '@playwright/test';
import type { RecordedClipboard } from '../../demo/src/clipboard-test';
import type { RemoteClipboardEvent } from '../../src/input/clipboard';
import { CLIPBOARD_ZSTD } from '../../test-fixtures/clipboard';

// ClipboardFormat.Text; the enum module is not ESM-loadable from Playwright's
// Node loader (protobufjs CJS resolution) and the demo page owns the wire type.
const CLIPBOARD_FORMAT_TEXT = 0;

// P3-5 browser acceptance: real navigator.clipboard with granted permissions,
// user-gesture local read and manual copy. Real iOS/Android clipboard
// permissions remain ⏳ 真机待验.

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const events = (page: Page): Promise<RemoteClipboardEvent[]> =>
  page.evaluate(() => window.clipboardTest?.events ?? []);

const messages = (page: Page): Promise<RecordedClipboard[]> =>
  page.evaluate(() => window.clipboardTest?.messages ?? []);

test('syncs text both ways through the real browser clipboard', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/clipboard-test.html');
  await page.waitForFunction(() => window.clipboardTest?.ready === true);
  await page.bringToFront();

  // Remote → local: automatic write.
  await page.evaluate(() => window.clipboardTest?.receivePlain('远端自动复制'));
  await expect.poll(async () => (await events(page)).length).toBe(1);
  expect((await events(page))[0]).toEqual({
    text: '远端自动复制',
    copied: true,
  });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    '远端自动复制',
  );

  // Remote → local: compressed zstd frame.
  await page.evaluate(
    (base64) => window.clipboardTest?.receiveCompressed(base64),
    CLIPBOARD_ZSTD.knownSizeBase64,
  );
  await expect.poll(async () => (await events(page)).length).toBe(2);
  expect((await events(page))[1]).toEqual({
    text: CLIPBOARD_ZSTD.text,
    copied: true,
  });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    CLIPBOARD_ZSTD.text,
  );

  // Local → remote: button click satisfies the readText user gesture.
  await page.evaluate(() => navigator.clipboard.writeText('本地发送'));
  await page.click('#send-local');
  await expect.poll(async () => (await messages(page)).length).toBe(1);
  expect((await messages(page))[0]).toEqual({
    format: CLIPBOARD_FORMAT_TEXT,
    compress: false,
    text: '本地发送',
  });

  // Manual copy: auto-copy disabled, then copy from a click.
  await page.evaluate(() => window.clipboardTest?.setAutoCopy(false));
  await page.evaluate(() => window.clipboardTest?.receivePlain('手动复制'));
  await expect.poll(async () => (await events(page)).length).toBe(3);
  expect((await events(page))[2]).toEqual({
    text: '手动复制',
    copied: false,
  });
  await page.click('#copy-remote');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('手动复制');

  expect(await page.evaluate(() => window.clipboardTest?.errors)).toEqual([]);
  expect(errors).toEqual([]);
});
