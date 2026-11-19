#!/usr/bin/env node
// Local receiver for test-fixtures/remote-input-test.html.
// Binds 127.0.0.1 only and appends JSON lines to .local/remote-input-events.jsonl.
import { createWriteStream, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const host = process.env.RD_LOG_HOST ?? '127.0.0.1';
const port = Number(process.env.RD_LOG_PORT ?? '8787');
const dir = resolve(process.cwd(), '.local');
const file = resolve(dir, 'remote-input-events.jsonl');
mkdirSync(dir, { recursive: true });
const output = createWriteStream(file, { flags: 'a', mode: 0o600 });

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS, GET',
  'access-control-allow-headers': 'content-type',
};

function allowedOrigin(origin) {
  // file:// sends Origin: null; accept loopback pages only.
  return !origin || origin === 'null' || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

const server = createServer((request, response) => {
  if (!allowedOrigin(request.headers.origin)) {
    response.writeHead(403, cors);
    response.end();
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors);
    response.end();
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { ...cors, 'content-type': 'application/json' });
    response.end('{"ok":true}\n');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/event') {
    response.writeHead(404, cors);
    response.end();
    return;
  }

  let body = '';
  let tooLarge = false;
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 64 * 1024) {
      tooLarge = true;
      request.destroy();
    }
  });
  request.on('end', () => {
    if (tooLarge) return;
    try {
      const data = JSON.parse(body);
      const events = Array.isArray(data) ? data : [data];
      for (const event of events) output.write(`${JSON.stringify(event)}\n`);
      response.writeHead(204, cors);
      response.end();
    } catch {
      response.writeHead(400, cors);
      response.end();
    }
  });
});

server.listen(port, host, () => {
  console.log(`event log: http://${host}:${port}/event -> ${file}`);
});
