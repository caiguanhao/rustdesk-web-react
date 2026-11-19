import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { WebSocketServer } from 'ws';

// P4-2 browser acceptance: after StrictMode's double mount only one WebSocket
// may stay live (the RTL test asserts the first session's connection is
// closed), and unmounting closes the remaining socket. The server never
// answers the RustDesk handshake; this test is about lifecycle only.

test('StrictMode keeps one live socket and disposes it on unmount', async ({
  page,
}) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  if (!server.address()) await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  try {
    await page.goto(`/strict-test.html?server=127.0.0.1:${port}`);
    await expect(page.locator('#status')).toHaveText('connecting');
    await expect.poll(() => server.clients.size).toBe(1);

    await page.click('#unmount');
    await expect(page.locator('#unmounted')).toBeVisible();
    await expect.poll(() => server.clients.size).toBe(0);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
