import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { WebSocketServer } from 'ws';

// P4-4 browser acceptance: submit the demo form, prove the viewer starts a
// real rendezvous WebSocket (a bare server is enough; the handshake is tested
// by the mock-relay suites), and assert non-password fields persist while the
// password never reaches localStorage or the console. A local
// VITE_RD_PASSWORD may prefill the field by design, so the reload assertion
// checks that the submitted test password is not restored.

const PASSWORD = 'p4-4-demo-password-not-saved';
const STORAGE_KEY = 'rustdesk-web-react.demo.form.v1';

test('demo form connects and never stores the password', async ({ page }) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  if (!server.address()) await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  // A server with an explicit port shifts the WS port by +2.
  const serverField = `127.0.0.1:${port - 2}`;

  const errors: string[] = [];
  const consoleText: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    consoleText.push(message.text());
    if (message.type() === 'error') errors.push(message.text());
  });

  try {
    // A fresh Playwright context has empty storage; fill every persisted
    // field so env prefills cannot affect the saved-object assertion.
    await page.goto('/');
    // Stay deterministic if demo/.env.local switches the default mode.
    await page.selectOption('#rd-credential-mode', 'password');
    await page.check('input[name="rd-relay-mode"][value="server"]');

    await page.fill('#rd-server', serverField);
    await page.fill('#rd-server-key', 'test-server-key');
    await page.fill('#rd-relay', 'relay.example:21117');
    await page.fill('#rd-id', '123456789');
    await page.fill('#rd-password', PASSWORD);
    await page.fill('#rd-asset-base', '/rustdesk-assets/');
    await page.click('#rd-connect');

    const viewer = page.locator('[data-rustdesk-viewer]');
    await expect(viewer).toBeVisible();
    await expect(viewer).toHaveAttribute(
      'data-status',
      /connecting|securing/,
    );
    await expect(page.locator('[data-demo-status]')).toHaveAttribute(
      'data-demo-status',
      /connecting|securing/,
    );
    await expect.poll(() => server.clients.size).toBe(1);

    const saved = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? '{}') as unknown,
      STORAGE_KEY,
    );
    expect(saved).toMatchObject({
      credentialMode: 'password',
      relayMode: 'server',
      server: serverField,
      serverKey: 'test-server-key',
      relayServer: 'relay.example:21117',
      id: '123456789',
      assetBaseUrl: '/rustdesk-assets/',
    });
    expect(saved).not.toHaveProperty('password');
    expect(consoleText.join('\n')).not.toContain(PASSWORD);

    // Closing the viewer from the demo disposes the session/socket and clears
    // the submitted password from the form.
    await page.click('#rd-close');
    await expect(page.locator('#rd-server')).toBeVisible();
    await expect(page.locator('#rd-password')).toHaveValue('');
    await expect.poll(() => server.clients.size).toBe(0);

    await page.reload();
    await expect(page.locator('#rd-server')).toHaveValue(serverField);
    await expect(page.locator('#rd-server-key')).toHaveValue(
      'test-server-key',
    );
    await expect(page.locator('#rd-id')).toHaveValue('123456789');
    await expect(page.locator('#rd-password')).not.toHaveValue(PASSWORD);
    expect(errors).toEqual([]);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('demo relay override switches between server and URL', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#rd-relay')).toBeVisible();

  await page.check('input[name="rd-relay-mode"][value="url"]');
  await expect(page.locator('#rd-relay-url')).toBeVisible();
  await expect(page.locator('#rd-relay')).toHaveCount(0);

  await page.fill('#rd-relay-url', 'wss://relay.example/ws/relay');
  await page.check('input[name="rd-relay-mode"][value="server"]');
  await expect(page.locator('#rd-relay')).toBeVisible();

  await page.check('input[name="rd-relay-mode"][value="url"]');
  await expect(page.locator('#rd-relay-url')).toHaveValue(
    'wss://relay.example/ws/relay',
  );
});
