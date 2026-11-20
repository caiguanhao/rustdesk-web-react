import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const MAX_BODY_BYTES = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new Error('Request body too large');
  }
  return JSON.parse(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

/**
 * Dev/preview-only stand-in for a host backend.
 *
 * POST { serverKey, password, salt } -> { passwordHash, serverKeyVerifier }.
 * This mirrors a host backend: h1 = SHA256(UTF8(password) || UTF8(salt)), and the
 * serverKey is wrapped as `signature || "1000::<serverKey>"` with a fresh
 * Ed25519 keypair. It is not part of the static build and must never be used
 * as a production backend (it receives a plaintext password and exposes the
 * signed server key to the browser).
 */
async function credentialHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Use POST' });
    return;
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Invalid JSON body',
    });
    return;
  }
  if (!body || typeof body !== 'object') {
    sendJson(res, 400, { error: 'Expected a JSON object' });
    return;
  }

  const { serverKey, password, salt } = body as Record<string, unknown>;
  if (typeof serverKey !== 'string' || serverKey.trim() === '') {
    sendJson(res, 400, { error: 'serverKey is required' });
    return;
  }
  if (typeof password !== 'string' || password === '') {
    sendJson(res, 400, { error: 'password is required' });
    return;
  }
  if (typeof salt !== 'string' || salt === '') {
    sendJson(res, 400, {
      error: 'salt is required (peer Hash.salt from RustDesk.toml)',
    });
    return;
  }

  const key = serverKey.trim();
  if (Buffer.from(key, 'base64').length !== 32) {
    sendJson(res, 400, { error: 'serverKey must be a base64 32-byte key' });
    return;
  }

  try {
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const keys = sodium.crypto_sign_keypair();
    const signed = sodium.crypto_sign(
      new TextEncoder().encode(`1000::${key}`),
      keys.privateKey,
    );
    const passwordHash = createHash('sha256')
      .update(password, 'utf8')
      .update(salt, 'utf8')
      .digest('base64');

    sendJson(res, 200, {
      passwordHash,
      serverKeyVerifier: {
        publicKey: Buffer.from(keys.publicKey).toString('base64'),
        verifier: Buffer.from(signed).toString('base64'),
      },
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : 'Credential generation failed',
    });
  }
}

function credentialApi(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse): void => {
    void credentialHandler(req, res);
  };
  return {
    name: 'demo-rustdesk-credential-api',
    configureServer(server) {
      server.middlewares.use('/api/rustdesk/credential', middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/rustdesk/credential', middleware);
    },
  };
}

// The demo consumes the library through its public entry points, exactly like
// a host application would.
export default defineConfig({
  root: here('.'),
  plugins: [react(), credentialApi()],
  resolve: {
    alias: [
      { find: 'rustdesk-web-react/core', replacement: here('../src/core.ts') },
      { find: 'rustdesk-web-react', replacement: here('../src/index.ts') },
    ],
  },
});
