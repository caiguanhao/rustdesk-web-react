import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import type { RemoteClipboardEvent } from '../src/input/clipboard';
import {
  ClipboardFormat,
  PermissionInfo_Permission,
} from '../src/protocol/message';
import type { WebSocketLike } from '../src/protocol/websock';
import { RustDeskError } from '../src/session/errors';
import type { RustDeskSessionConfig } from '../src/session/options';
import { RustDeskSession } from '../src/session/RustDeskSession';
import type { RustDeskStatusEvent } from '../src/session/state';
import { MockRustDeskServer, waitFor } from './mocks/rustdesk-mock';

// P4-1 integration: the real encrypted mock hbbs/hbbr/peer drives connect,
// login retry, post-login video acks, permission revocation, clipboard and
// close_reason through RustDeskSession's own loop.

const createSocket = (url: string): WebSocketLike =>
  new WsClient(url) as unknown as WebSocketLike;

const sessions: RustDeskSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
});

interface Harness {
  session: RustDeskSession;
  statuses: RustDeskStatusEvent[];
  errors: RustDeskError[];
  clipboards: RemoteClipboardEvent[];
}

function makeHarness(
  mock: MockRustDeskServer,
  config: Partial<RustDeskSessionConfig> = {},
): Harness {
  const statuses: RustDeskStatusEvent[] = [];
  const errors: RustDeskError[] = [];
  const clipboards: RemoteClipboardEvent[] = [];
  const session = new RustDeskSession(
    {
      server: mock.server,
      serverKey: mock.serverKey,
      id: mock.peerId,
      password: mock.password,
      ...config,
    },
    {
      secure: false,
      createSocket,
      autoCopyClipboard: false,
      heartbeatIntervalMs: 1_000,
    },
  );
  session.on('status', (event) => statuses.push(event));
  session.on('error', (error) => errors.push(error));
  session.on('clipboard', (event) => clipboards.push(event));
  sessions.push(session);
  return { session, statuses, errors, clipboards };
}

describe('RustDeskSession over the mock relay', () => {
  it('connects, acks video, routes permissions/clipboard and reports peer close', async () => {
    const mock = await MockRustDeskServer.start();
    try {
      const harness = makeHarness(mock);
      const info = await harness.session.connect();
      expect(info.username).toBe('alice');
      expect(harness.session.status).toBe('connected');
      expect(harness.statuses.map((event) => event.status)).toEqual(
        expect.arrayContaining([
          'connecting',
          'securing',
          'authenticating',
          'connected',
        ]),
      );

      await waitFor(() => mock.videoAcks >= 1, 2000);

      mock.sendPermissionInfo(
        PermissionInfo_Permission.Keyboard,
        false,
      );
      await waitFor(
        () => harness.errors.some((error) => error.code === 'no-permission'),
        2000,
      );
      expect(harness.session.permissions.policy.mouse).toBe(false);

      mock.sendPermissionInfo(PermissionInfo_Permission.Keyboard, true);
      await waitFor(() => harness.session.permissions.policy.mouse, 2000);
      expect(harness.session.sendText('本地文本')).toBe(true);
      await waitFor(
        () => mock.inputs.some((message) => message.clipboard),
        2000,
      );
      const sent = mock.inputs.find((message) => message.clipboard)?.clipboard;
      expect(sent?.format).toBe(ClipboardFormat.Text);
      expect(new TextDecoder().decode(sent?.content)).toBe('本地文本');

      mock.sendClipboard({
        format: ClipboardFormat.Text,
        compress: false,
        content: new TextEncoder().encode('remote text'),
      });
      await waitFor(() => harness.clipboards.length === 1, 2000);
      expect(harness.clipboards[0]).toEqual({
        text: 'remote text',
        copied: false,
      });

      mock.sendCloseReason('maintenance');
      await waitFor(
        () => harness.session.status === 'disconnected',
        2000,
      );
      expect(harness.statuses.at(-1)).toMatchObject({
        status: 'disconnected',
        detail: 'maintenance',
      });
    } finally {
      await mock.close();
    }
  });

  it('retries a wrong password on the same connection', async () => {
    const mock = await MockRustDeskServer.start({
      password: 'real-password',
      sendVideoFrame: false,
    });
    try {
      const harness = makeHarness(mock, { password: 'wrong' });
      const connecting = harness.session.connect();
      await waitFor(
        () =>
          harness.statuses.some(
            (event) =>
              event.status === 'password-required' && event.retry === true,
          ),
        5000,
      );
      const info = await harness.session.login('real-password');
      await connecting;

      expect(info.username).toBe('alice');
      expect(harness.session.status).toBe('connected');
      expect(mock.loginRequests).toHaveLength(2);
    } finally {
      await mock.close();
    }
  });
});
