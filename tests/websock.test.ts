import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket as WsClient, WebSocketServer, type RawData } from 'ws';
import { RustDeskError, type RustDeskErrorCode } from '../src/session/errors';
import * as message from '../src/protocol/message';
import * as rendezvous from '../src/protocol/rendezvous';
import {
  WebSock,
  type WebSockCloseEvent,
  type WebSocketLike,
} from '../src/protocol/websock';

// P1-3: real mock WebSocket server coverage (binary framing, queue, timeouts,
// close/error mapping, cipher hook) plus fake sockets for pre-open failures.

const createSocket = (url: string): WebSocketLike =>
  new WsClient(url) as unknown as WebSocketLike;

function rawToBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function bytesOf(value: Uint8Array): number[] {
  return Array.from(value);
}

async function expectCode(promise: Promise<unknown>, code: RustDeskErrorCode): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected rejection with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RustDeskError);
    expect((error as RustDeskError).code).toBe(code);
  }
}

interface TestServer {
  url: string;
  connect: Promise<WsClient>;
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let resolveSocket!: (socket: WsClient) => void;
  const connect = new Promise<WsClient>((resolve) => {
    resolveSocket = resolve;
  });
  server.once('connection', resolveSocket);

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server has no port');
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    connect,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

class FakeSocket implements WebSocketLike {
  binaryType = 'arraybuffer';
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean?: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: Uint8Array[] = [];
  closeCalls: { code?: number; reason?: string }[] = [];

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }

  fail(): void {
    this.onerror?.(new Error('boom'));
  }

  remoteClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: false });
  }
}

describe('WebSock with a mock server', () => {
  it('sends exactly one protobuf per binary frame, without a length prefix', async () => {
    const server = await startServer();
    const sock = new WebSock(server.url, { createSocket });
    try {
      await sock.open(1000);
      const serverSocket = await server.connect;

      const firstFrame = new Promise<Uint8Array>((resolve) => {
        serverSocket.once('message', (data) => resolve(rawToBytes(data)));
      });
      sock.sendMessage({ test_delay: { time: 1, from_client: true } });
      const expected = message.Message.encode(
        message.Message.fromPartial({ test_delay: { time: 1, from_client: true } }),
      ).finish();
      expect(bytesOf(await firstFrame)).toEqual(bytesOf(expected));

      const secondFrame = new Promise<Uint8Array>((resolve) => {
        serverSocket.once('message', (data) => resolve(rawToBytes(data)));
      });
      sock.sendRendezvous({ punch_hole_request: { id: '123' } });
      const expectedRendezvous = rendezvous.RendezvousMessage.encode(
        rendezvous.RendezvousMessage.fromPartial({ punch_hole_request: { id: '123' } }),
      ).finish();
      expect(bytesOf(await secondFrame)).toEqual(bytesOf(expectedRendezvous));
    } finally {
      sock.close();
      await server.close();
    }
  });

  it('queues inbound frames and resolves next calls in order', async () => {
    const server = await startServer();
    const sock = new WebSock(server.url, { createSocket });
    try {
      await sock.open(1000);
      const serverSocket = await server.connect;

      for (const time of [10, 20, 30]) {
        serverSocket.send(
          message.Message.encode(
            message.Message.fromPartial({ test_delay: { time, from_client: false } }),
          ).finish(),
        );
      }

      await expect(sock.nextMessage(1000)).resolves.toMatchObject({
        test_delay: { time: 10 },
      });
      await expect(sock.nextMessage(1000)).resolves.toMatchObject({
        test_delay: { time: 20 },
      });
      await expect(sock.nextMessage(1000)).resolves.toMatchObject({
        test_delay: { time: 30 },
      });
    } finally {
      sock.close();
      await server.close();
    }
  });

  it('emits raw message events and supports unsubscribe', async () => {
    const server = await startServer();
    const sock = new WebSock(server.url, { createSocket });
    try {
      await sock.open(1000);
      const serverSocket = await server.connect;

      let events = 0;
      const unsubscribe = sock.on('message', () => {
        events += 1;
      });

      const payload = message.Message.encode(
        message.Message.fromPartial({ test_delay: { time: 1, from_client: false } }),
      ).finish();
      serverSocket.send(payload);
      await sock.nextMessage(1000);
      expect(events).toBe(1);

      unsubscribe();
      serverSocket.send(payload);
      await sock.nextMessage(1000);
      expect(events).toBe(1);
    } finally {
      sock.close();
      await server.close();
    }
  });

  it('times out next waits with a typed timeout', async () => {
    const server = await startServer();
    const sock = new WebSock(server.url, { createSocket });
    try {
      await sock.open(1000);
      await server.connect;
      await expectCode(sock.nextMessage(25), 'timeout');
    } finally {
      sock.close();
      await server.close();
    }
  });

  it('rejects pending next calls on remote close and reports the close event', async () => {
    const server = await startServer();
    const sock = new WebSock(server.url, { createSocket });
    try {
      await sock.open(1000);
      const serverSocket = await server.connect;
      const closeEvent = new Promise<WebSockCloseEvent>((resolve) => {
        sock.on('close', resolve);
      });

      const pending = sock.nextMessage(1000);
      const expectation = expectCode(pending, 'connection-lost');
      serverSocket.close(1000, 'bye');
      await expectation;
      expect(await closeEvent).toMatchObject({
        code: 1000,
        reason: 'bye',
        local: false,
      });
    } finally {
      sock.close();
      await server.close();
    }
  });

  it('maps close code 1009 to message-too-large', async () => {
    const server = await startServer();
    const sock = new WebSock(server.url, { createSocket });
    try {
      await sock.open(1000);
      const serverSocket = await server.connect;
      const pending = sock.nextMessage(1000);
      const expectation = expectCode(pending, 'message-too-large');
      serverSocket.close(1009, 'too big');
      await expectation;
    } finally {
      sock.close();
      await server.close();
    }
  });

  it('rejects pending next calls with aborted on local close', async () => {
    const server = await startServer();
    const sock = new WebSock(server.url, { createSocket });
    try {
      await sock.open(1000);
      await server.connect;
      const closeEvent = new Promise<WebSockCloseEvent>((resolve) => {
        sock.on('close', resolve);
      });

      const pending = sock.nextMessage(1000);
      const expectation = expectCode(pending, 'aborted');
      sock.close();
      await expectation;
      expect(await closeEvent).toMatchObject({ local: true });
      expect(() => sock.sendMessage({})).toThrowError(RustDeskError);
    } finally {
      sock.close();
      await server.close();
    }
  });

  it('applies the cipher to Message frames only', async () => {
    const server = await startServer();
    const sock = new WebSock(server.url, { createSocket });
    const xor = (bytes: Uint8Array): Uint8Array => bytes.map((byte) => byte ^ 0x5a);
    try {
      await sock.open(1000);
      const serverSocket = await server.connect;
      sock.setCipher({ encrypt: xor, decrypt: xor });

      const encryptedFrame = new Promise<Uint8Array>((resolve) => {
        serverSocket.once('message', (data) => resolve(rawToBytes(data)));
      });
      sock.sendMessage({ test_delay: { time: 7, from_client: true } });
      const plaintext = message.Message.encode(
        message.Message.fromPartial({ test_delay: { time: 7, from_client: true } }),
      ).finish();
      expect(bytesOf(await encryptedFrame)).toEqual(bytesOf(xor(plaintext)));

      serverSocket.send(
        xor(
          message.Message.encode(
            message.Message.fromPartial({ test_delay: { time: 8, from_client: false } }),
          ).finish(),
        ),
      );
      await expect(sock.nextMessage(1000)).resolves.toMatchObject({
        test_delay: { time: 8 },
      });

      const rendezvousFrame = new Promise<Uint8Array>((resolve) => {
        serverSocket.once('message', (data) => resolve(rawToBytes(data)));
      });
      sock.sendRendezvous({ punch_hole_request: { id: '1' } });
      const rendezvousPlain = rendezvous.RendezvousMessage.encode(
        rendezvous.RendezvousMessage.fromPartial({ punch_hole_request: { id: '1' } }),
      ).finish();
      expect(bytesOf(await rendezvousFrame)).toEqual(bytesOf(rendezvousPlain));
    } finally {
      sock.close();
      await server.close();
    }
  });

  it('rejects malformed binary frames with protocol-error', async () => {
    const server = await startServer();
    const sock = new WebSock(server.url, { createSocket });
    try {
      await sock.open(1000);
      const serverSocket = await server.connect;
      const pending = sock.nextMessage(1000);
      const expectation = expectCode(pending, 'protocol-error');
      serverSocket.send(Uint8Array.from([0x12, 0x05, 0x01]));
      await expectation;
    } finally {
      sock.close();
      await server.close();
    }
  });
});

describe('WebSock pre-open failures', () => {
  it('times out opening and closes the socket', async () => {
    const fake = new FakeSocket();
    const sock = new WebSock('ws://fake', { createSocket: () => fake, openTimeoutMs: 20 });
    await expectCode(sock.open(), 'timeout');
    expect(fake.closeCalls).toHaveLength(1);

    const sent = fake.sent.length;
    expect(() => sock.sendMessage({})).toThrowError(RustDeskError);
    expect(fake.sent).toHaveLength(sent);
  });

  it('maps a pre-open WebSocket error to server-unreachable', async () => {
    const fake = new FakeSocket();
    const sock = new WebSock('ws://fake', { createSocket: () => fake });
    const errors: RustDeskError[] = [];
    sock.on('error', (error) => errors.push(error));
    const opening = sock.open(1000);
    fake.fail();
    await expectCode(opening, 'server-unreachable');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('server-unreachable');
  });

  it('maps a pre-open close to server-unreachable', async () => {
    const fake = new FakeSocket();
    const sock = new WebSock('ws://fake', { createSocket: () => fake });
    const opening = sock.open(1000);
    fake.remoteClose(1006, 'refused');
    await expectCode(opening, 'server-unreachable');
    await expectCode(sock.nextMessage(10), 'server-unreachable');
  });

  it('rejects text frames with protocol-error', async () => {
    const fake = new FakeSocket();
    const sock = new WebSock('ws://fake', { createSocket: () => fake });
    const opening = sock.open(1000);
    fake.open();
    await opening;

    const pending = sock.nextMessage(1000);
    fake.receive('not protobuf');
    await expectCode(pending, 'protocol-error');
    await expectCode(sock.nextMessage(10), 'protocol-error');
  });
});
