// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import {
  act,
  cleanup,
  renderHook,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RustDeskError } from '../src/session/errors';
import type { RustDeskSessionConfig } from '../src/session/options';
import { RustDeskSession } from '../src/session/RustDeskSession';
import {
  useRustDeskSession,
  type UseRustDeskSessionOptions,
} from '../src/react/useRustDeskSession';
import type { PeerInfo } from '../src/session/peer-info';
import {
  FAKE_HASH,
  FakeConnection,
  completeFakeLogin,
  peerInfoPayload,
} from './mocks/fake-connection';

// P4-2 hook coverage: auto-connect, StrictMode double-mount socket cleanup,
// unmount disposal, password retry, config changes, error callbacks and
// session events. Real RustDeskSession instances run against FakeConnection.

const baseConfig: RustDeskSessionConfig = {
  server: '127.0.0.1:21116',
  id: '123456789',
  password: 'secret',
  assetBaseUrl: '/assets/',
};

interface Factory {
  connections: FakeConnection[];
  createSession: (config: RustDeskSessionConfig) => RustDeskSession;
}

function makeFactory(
  connect: () => Promise<FakeConnection> = async () =>
    new FakeConnection(),
): Factory {
  const connections: FakeConnection[] = [];
  return {
    connections,
    createSession: (config) => {
      return new RustDeskSession(config, {
        connectRelay: async (options) => {
          options.onSecuring?.();
          const connection = await connect();
          connections.push(connection);
          return connection;
        },
        secure: false,
        autoCopyClipboard: false,
        heartbeatIntervalMs: 50,
      });
    },
  };
}

async function expectConnected(
  result: { current: { status: string; peerInfo?: PeerInfo } },
): Promise<void> {
  await waitFor(() => expect(result.current.status).toBe('connected'));
  expect(result.current.peerInfo?.username).toBe('alice');
}

afterEach(() => {
  cleanup();
});

describe('useRustDeskSession', () => {
  it('auto-connects, exposes peer info/status and forwards events', async () => {
    const factory = makeFactory();
    const onStatus = vi.fn();
    const onPeerInfo = vi.fn();
    const onClipboard = vi.fn();
    const onPermission = vi.fn();
    const options: UseRustDeskSessionOptions = {
      createSession: factory.createSession,
      onStatusChange: onStatus,
      onPeerInfo,
      onClipboard,
      onPermission,
    };
    const { result } = renderHook(() =>
      useRustDeskSession(baseConfig, options),
    );

    await waitFor(() => expect(factory.connections).toHaveLength(1));
    expect(result.current.session).not.toBeNull();
    completeFakeLogin(factory.connections[0]!);
    await expectConnected(result);

    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'connected' }),
    );
    expect(onPeerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'alice' }),
    );

    factory.connections[0]!.push({
      clipboard: {
        format: 0,
        compress: false,
        content: new TextEncoder().encode('hello'),
      },
    });
    await waitFor(() =>
      expect(onClipboard).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'hello', copied: false }),
      ),
    );
    expect(result.current.clipboard?.text).toBe('hello');

    factory.connections[0]!.push({
      misc: {
        permission_info: { permission: 0, enabled: false },
      },
    });
    await waitFor(() =>
      expect(onPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          policy: expect.objectContaining({ mouse: false }),
        }),
      ),
    );
    expect(result.current.permission?.policy.mouse).toBe(false);
  });

  it('StrictMode closes the first connection and keeps only the second', async () => {
    const factory = makeFactory();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result, unmount } = renderHook(
      () =>
        useRustDeskSession(baseConfig, {
          createSession: factory.createSession,
        }),
      { wrapper },
    );

    await waitFor(() => expect(factory.connections).toHaveLength(2));
    await waitFor(() => expect(factory.connections[0]?.closed).toBe(true));
    expect(factory.connections[1]?.closed).toBe(false);

    completeFakeLogin(factory.connections[1]!);
    await expectConnected(result);
    expect(result.current.session).not.toBeNull();

    unmount();
    await waitFor(() => expect(factory.connections[1]?.closed).toBe(true));
  });

  it('logs in after password-required on the same connection', async () => {
    const factory = makeFactory();
    const { result } = renderHook(() =>
      useRustDeskSession(
        { ...baseConfig, password: undefined },
        { createSession: factory.createSession },
      ),
    );
    await waitFor(() => expect(factory.connections).toHaveLength(1));
    factory.connections[0]!.push({ hash: FAKE_HASH });
    await waitFor(() =>
      expect(result.current.status).toBe('password-required'),
    );

    await act(async () => {
      const pending = result.current.connect('secret');
      factory.connections[0]!.push(peerInfoPayload());
      await pending;
    });
    await expectConnected(result);
  });

  it('applies readOnly live without recreating the session', async () => {
    const factory = makeFactory();
    const { result, rerender } = renderHook(
      ({ readOnly }: { readOnly: boolean }) =>
        useRustDeskSession(
          { ...baseConfig, readOnly },
          { createSession: factory.createSession },
        ),
      { initialProps: { readOnly: false } },
    );
    await waitFor(() => expect(factory.connections).toHaveLength(1));
    completeFakeLogin(factory.connections[0]!);
    await expectConnected(result);

    rerender({ readOnly: true });
    await waitFor(() =>
      expect(result.current.session?.permissions.readOnly).toBe(true),
    );
    expect(factory.connections).toHaveLength(1);
    expect(result.current.status).toBe('connected');
  });

  it('recreates the session when the connection config changes', async () => {
    const factory = makeFactory();
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useRustDeskSession(
          { ...baseConfig, id },
          { createSession: factory.createSession },
        ),
      { initialProps: { id: '111' } },
    );
    await waitFor(() => expect(factory.connections).toHaveLength(1));
    completeFakeLogin(factory.connections[0]!);
    await expectConnected(result);

    rerender({ id: '222' });
    await waitFor(() => expect(factory.connections).toHaveLength(2));
    expect(factory.connections[0]?.closed).toBe(true);
    completeFakeLogin(factory.connections[1]!);
    await expectConnected(result);
  });

  it('reconnects through connect() after disconnect()', async () => {
    const factory = makeFactory();
    const { result } = renderHook(() =>
      useRustDeskSession(baseConfig, {
        createSession: factory.createSession,
      }),
    );
    await waitFor(() => expect(factory.connections).toHaveLength(1));
    completeFakeLogin(factory.connections[0]!);
    await expectConnected(result);

    act(() => {
      result.current.disconnect();
    });
    await waitFor(() => expect(result.current.status).toBe('disconnected'));
    expect(factory.connections[0]?.closed).toBe(true);

    let reconnecting: Promise<PeerInfo> | undefined;
    act(() => {
      reconnecting = result.current.connect();
    });
    await waitFor(() => expect(factory.connections).toHaveLength(2));
    completeFakeLogin(factory.connections[1]!);
    await act(async () => {
      await reconnecting;
    });
    await expectConnected(result);
  });

  it('reports fatal connection errors through state and onError', async () => {
    const errors: RustDeskError[] = [];
    const failure = new RustDeskError('peer-offline', 'Offline');
    const factory = makeFactory(async () => {
      throw failure;
    });
    const { result } = renderHook(() =>
      useRustDeskSession(baseConfig, {
        createSession: factory.createSession,
        onError: (error) => errors.push(error),
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(errors).toEqual([failure]);
    expect(result.current.error).toBe(failure);
  });
});
