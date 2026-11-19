import { expect, test } from '@playwright/test';

// P4-3 acceptance: the component renders inside a host React page in a real
// browser, keeps the host's 16:9 box, applies host labels/styles, gates the
// read-only toolbar and does not break the surrounding page. No connection is
// attempted (autoConnect=false); protocol behavior is covered by the mock
// relay tests and the real-device checkpoints.

test('embeds the viewer in a host page with host labels and styling', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/viewer-test.html');
  const viewer = page.locator('[data-rustdesk-viewer]');
  await expect(viewer).toHaveCount(1);
  await expect(viewer).toBeVisible();
  await expect(viewer).toHaveAttribute('data-status', 'idle');
  // StrictMode's first mount disposed its hidden IME input.
  await expect(page.locator('textarea')).toHaveCount(1);
  await expect(viewer).toHaveClass(/embedded-viewer/);
  await expect(page.locator('canvas[data-rustdesk-canvas]')).toBeVisible();
  await expect(page.locator('[data-rustdesk-toolbar]')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Connect now' }),
  ).toBeVisible();
  await expect(page.getByText('View only')).toBeVisible();

  // Read-only disables input controls; fullscreen is not an input and stays
  // available (headless Chromium supports Element.requestFullscreen).
  await expect(
    page.getByRole('button', { name: 'Soft keyboard' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Copy clipboard' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Fullscreen' }),
  ).toBeEnabled();

  // The host page around the viewer still works.
  await page.click('#host-button');
  await expect(page.locator('#host-clicks')).toHaveText('1');
  await expect(page.locator('#host-after')).toHaveText(
    'Host content after the viewer.',
  );

  // The viewer fills the host's 640px slot and keeps its 16:9 shell.
  const box = await viewer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeCloseTo(640, 0);
  expect(box!.height).toBeCloseTo(360, 0);

  expect(errors).toEqual([]);
});
