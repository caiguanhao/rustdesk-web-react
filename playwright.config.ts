import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Prefer Playwright's managed Chromium; fall back to a local Chrome so the
// canvas test runs without downloading browsers. CI can install Chromium with
// `npx playwright install chromium` or set CHROME_BIN.
const LOCAL_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath =
  process.env.CHROME_BIN ?? (existsSync(LOCAL_CHROME) ? LOCAL_CHROME : undefined);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    headless: true,
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      // WebGL may only be available through SwiftShader in headless CI.
      args: ['--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'npm run dev -- --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175/canvas-test.html',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
