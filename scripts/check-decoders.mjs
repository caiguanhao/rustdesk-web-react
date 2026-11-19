#!/usr/bin/env node
// P2-1 browser acceptance: start the demo Vite server, drive headless Chrome
// over CDP, and initialize/decode with both VP9 WASM builds.
//
//   npm run test:decoder
//
// Chrome must be installed locally (CHROME_BIN overrides the macOS default).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.RD_DECODER_PORT ?? '5199');
const PAGE_URL = `http://127.0.0.1:${PORT}/decoder-check.html`;
const CHROME =
  process.env.CHROME_BIN ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAX_HEAP_GROWTH = 8 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let vite;
let chrome;
let cdp;
let userDataDir;

async function poll(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await sleep(100);
  }
}

async function pageTarget(port) {
  return poll(
    async () => {
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        return list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      } catch {
        return undefined;
      }
    },
    20_000,
    'no Chrome page target',
  );
}

class Cdp {
  #socket;
  #nextId = 0;
  #pending = new Map();
  errors = [];

  constructor(socket) {
    this.#socket = socket;
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params?.exceptionDetails);
      } else if (
        message.method === 'Runtime.consoleAPICalled' &&
        message.params?.type === 'error'
      ) {
        this.errors.push(message.params.args?.map((arg) => arg.value ?? arg.description));
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        `page evaluation failed: ${JSON.stringify(response.exceptionDetails, null, 2)}`,
      );
    }
    return response.result?.value;
  }

  close() {
    this.#socket.close();
  }
}

async function run() {
  if (!existsSync(CHROME)) {
    throw new Error(
      `Chrome not found at ${CHROME}; set CHROME_BIN or install Google Chrome`,
    );
  }
  userDataDir = mkdtempSync(join(tmpdir(), 'rd-decoder-chrome-'));

  console.log('starting Vite…');
  vite = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', detached: process.platform !== 'win32' },
  );
  await poll(
    async () => {
      try {
        return (await fetch(PAGE_URL)).ok;
      } catch {
        return false;
      }
    },
    30_000,
    `${PAGE_URL} did not become ready`,
  );

  console.log('launching headless Chrome…');
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
      '--disable-gpu',
      PAGE_URL,
    ],
    { stdio: 'ignore' },
  );

  await poll(
    async () => existsSync(join(userDataDir, 'DevToolsActivePort')),
    20_000,
    'Chrome did not expose DevToolsActivePort',
  );
  const devtoolsPort = Number(
    readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0],
  );
  const target = await pageTarget(devtoolsPort);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  cdp = new Cdp(socket);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  await poll(
    () => cdp.evaluate('Boolean(window.decoderCheckReady)').catch(() => false),
    30_000,
    'decoder-check page did not load',
  );

  const results = [];
  for (const mode of ['simd', 'non-simd', 'auto']) {
    console.log(`checking ${mode} decoder…`);
    const result = await cdp.evaluate(`runDecoderCheck(${JSON.stringify(mode)})`);
    if (!result || result.decoded !== result.iterations) {
      throw new Error(`${mode} decoder failed: ${JSON.stringify(result)}`);
    }
    if (mode === 'simd' && !result.simd) throw new Error('SIMD check used non-SIMD');
    if (mode === 'non-simd' && result.simd) throw new Error('non-SIMD check used SIMD');
    if (result.heapDelta !== null && result.heapDelta > MAX_HEAP_GROWTH) {
      throw new Error(`${mode} decoder heap grew by ${result.heapDelta} bytes`);
    }
    results.push(result);
  }

  if (cdp.errors.length > 0) {
    throw new Error(`browser errors: ${JSON.stringify(cdp.errors, null, 2)}`);
  }

  console.log(JSON.stringify(results, null, 2));
  console.log('decoder check OK');
}

const timeout = setTimeout(() => {
  console.error('decoder check timed out');
  process.exit(1);
}, 120_000);
timeout.unref();

try {
  await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  cdp?.close();
  try {
    if (vite && process.platform !== 'win32') process.kill(-vite.pid, 'SIGKILL');
    else vite?.kill('SIGKILL');
  } catch {
    // already gone
  }
  chrome?.kill('SIGKILL');
  if (userDataDir) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
