// @vitest-environment jsdom
import { createRef, type RefObject } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no canvas implementation. The browser tests exercise the real
// yuv-canvas path; the viewer only needs a structural frame sink here.
vi.mock('yuv-canvas', async () => import('./mocks/fake-yuv-canvas'));

import { ImeInput } from '../src/input/ime';
import { KeyboardInput } from '../src/input/keyboard';
import { VideoRenderer } from '../src/media/renderer';
import {
  RustDeskViewer,
  type RustDeskViewerProps,
  type RustDeskViewerRef,
} from '../src/react/RustDeskViewer';
import { RustDeskError } from '../src/session/errors';
import type { PeerInfo } from '../src/session/peer-info';
import type { PermissionEvent } from '../src/session/permissions';
import {
  RustDeskSession,
  type RustDeskSessionEvents,
} from '../src/session/RustDeskSession';
import type { RustDeskStatusEvent } from '../src/session/state';

// P4-3 viewer coverage. The real hook and RustDeskSession run in jsdom; only
// the network connect/login boundary is stubbed so status/password events can
// be driven deterministically. This verifies the actual wiring (renderer sink,
// input controllers, permission + focus gates, overlays, toolbar, cleanup).

const PEER: PeerInfo = {
  username: 'alice',
  hostname: 'desktop',
  platform: 'Windows',
  displays: [
    { x: 0, y: 0, width: 1920, height: 1080, name: 'Main', online: true },
  ],
  currentDisplay: 0,
  sasEnabled: true,
  version: '1.5.3',
  connectionId: 42,
  privacyMode: false,
};

const BASE_PROPS: RustDeskViewerProps = {
  server: '127.0.0.1:21116',
  id: '123456789',
  assetBaseUrl: '/assets/',
};

const ALL_ALLOWED: PermissionEvent = {
  policy: {
    mouse: true,
    keyboard: true,
    touch: true,
    ime: true,
    clipboardSend: true,
    clipboardReceive: true,
  },
  permissions: {
    keyboard: true,
    clipboard: true,
    audio: true,
    file: true,
  },
};

let session: RustDeskSession | undefined;

function emit<K extends keyof RustDeskSessionEvents>(
  type: K,
  payload: RustDeskSessionEvents[K],
): void {
  if (!session) throw new Error('session was not created');
  (
    session as unknown as {
      emit(kind: K, value: RustDeskSessionEvents[K]): void;
    }
  ).emit(type, payload);
}

function status(value: RustDeskStatusEvent['status']): RustDeskStatusEvent {
  return value === 'password-required'
    ? { status: value, retry: false }
    : { status: value };
}

function renderViewer(overrides: Partial<RustDeskViewerProps> = {}): {
  container: HTMLElement;
  ref: RefObject<RustDeskViewerRef>;
  root: () => HTMLElement;
} {
  const ref = createRef<RustDeskViewerRef>();
  const { container } = render(
    <RustDeskViewer {...BASE_PROPS} {...overrides} ref={ref} />,
  );
  return {
    container,
    ref,
    root: () => {
      const root = container.querySelector<HTMLElement>(
        '[data-rustdesk-viewer]',
      );
      if (!root) throw new Error('viewer root missing');
      return root;
    },
  };
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

async function connected(name?: string): Promise<void> {
  await waitFor(() => expect(session).toBeDefined());
  act(() => {
    emit('status', status('connecting'));
    emit('status', status('connected'));
    emit('peerInfo', PEER);
  });
  await waitFor(() =>
    expect(
      document
        .querySelector('[data-rustdesk-viewer]')
        ?.getAttribute('data-status'),
    ).toBe('connected'),
  );
  if (name) await waitFor(() => expect(button(name)).toBeTruthy());
}

beforeEach(() => {
  session = undefined;
  vi.spyOn(RustDeskSession.prototype, 'connect').mockImplementation(
    function (this: RustDeskSession) {
      session = this;
      return new Promise<PeerInfo>(() => {});
    },
  );
  vi.spyOn(RustDeskSession.prototype, 'disconnect').mockImplementation(
    () => {},
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RustDeskViewer', () => {
  it('renders an embeddable shell, canvas, toolbar and host labels', () => {
    const { container, root } = renderViewer({
      autoConnect: false,
      className: 'host-viewer',
      style: { height: 240 },
      labels: { connect: 'Open', clipboard: 'Zwischenablage' },
    });

    expect(root().getAttribute('data-status')).toBe('idle');
    expect(root().className).toBe('host-viewer');
    expect(root().style.height).toBe('240px');
    expect(root().style.aspectRatio).toContain('16');
    expect(container.querySelector('canvas')).not.toBeNull();
    expect(button('Open')).toBeDefined();
    expect(screen.getByRole('toolbar')).toBeDefined();
    expect(button('Zwischenablage')).toBeDefined();
  });

  it('auto-connects, forwards status/peer info and hides the overlay', async () => {
    const onStatus = vi.fn();
    const onPeerInfo = vi.fn();
    const { root } = renderViewer({
      autoConnect: true,
      onStatusChange: onStatus,
      onPeerInfo,
    });

    await connected();
    expect(root().getAttribute('data-status')).toBe('connected');
    expect(screen.queryByText('Connecting…')).toBeNull();
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'connected' }),
    );
    expect(onPeerInfo).toHaveBeenCalledWith(PEER);
  });

  it('lets the host answer the password prompt with a string', async () => {
    const login = vi
      .spyOn(RustDeskSession.prototype, 'login')
      .mockResolvedValue(PEER);
    const onPasswordRequired = vi.fn().mockResolvedValue('secret');
    renderViewer({ autoConnect: true, onPasswordRequired });

    await waitFor(() => expect(session).toBeDefined());
    act(() => {
      emit('status', {
        status: 'password-required',
        retry: true,
        detail: 'Wrong Password',
      });
    });

    await waitFor(() =>
      expect(onPasswordRequired).toHaveBeenCalledWith({
        retry: true,
        error: 'Wrong Password',
      }),
    );
    await waitFor(() => expect(login).toHaveBeenCalledWith('secret'));
    // The host answered, so the built-in form never appeared.
    expect(
      screen.queryByLabelText('Enter the remote device password'),
    ).toBeNull();
  });

  it('falls back to the built-in form and submits the password', async () => {
    const login = vi
      .spyOn(RustDeskSession.prototype, 'login')
      .mockResolvedValue(PEER);
    const disconnect = vi.mocked(RustDeskSession.prototype.disconnect);
    renderViewer({ autoConnect: true });

    await waitFor(() => expect(session).toBeDefined());
    act(() => {
      emit('status', { status: 'password-required', retry: false });
    });

    const input = (await screen.findByLabelText(
      'Enter the remote device password',
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'secret' } });
    fireEvent.click(button('Connect'));

    await waitFor(() => expect(login).toHaveBeenCalledWith('secret'));
    await waitFor(() =>
      expect(
        screen.queryByLabelText('Enter the remote device password'),
      ).toBeNull(),
    );

    // A rejected password comes back as a retry with the peer's message.
    act(() => {
      emit('status', {
        status: 'password-required',
        retry: true,
        detail: 'Wrong Password',
      });
    });
    await waitFor(() =>
      expect(screen.getByText('Wrong Password')).toBeTruthy(),
    );

    fireEvent.click(button('Cancel'));
    expect(disconnect).toHaveBeenCalled();
  });

  it('wires toolbar commands when connected', async () => {
    const sendLocal = vi
      .spyOn(RustDeskSession.prototype, 'sendLocalClipboard')
      .mockResolvedValue(true);
    const focusIme = vi
      .spyOn(ImeInput.prototype, 'focus')
      .mockReturnValue(true);
    const ctrlAltDel = vi
      .spyOn(KeyboardInput.prototype, 'sendCtrlAltDel')
      .mockImplementation(() => {});
    const disconnect = vi.mocked(RustDeskSession.prototype.disconnect);
    renderViewer({ autoConnect: true });

    await connected('Ctrl+Alt+Del');
    fireEvent.click(button('Ctrl+Alt+Del'));
    expect(ctrlAltDel).toHaveBeenCalledTimes(1);

    fireEvent.click(button('Keyboard'));
    expect(focusIme).toHaveBeenCalledTimes(1);

    fireEvent.click(button('Clipboard'));
    await waitFor(() => expect(sendLocal).toHaveBeenCalledTimes(1));

    fireEvent.click(button('Disconnect'));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('disables input controls and shows the badge in read-only mode', async () => {
    renderViewer({ autoConnect: true, readOnly: true });
    await connected('Ctrl+Alt+Del');

    expect(screen.getByText('View only')).toBeDefined();
    expect(button('Ctrl+Alt+Del').disabled).toBe(true);
    expect(button('Keyboard').disabled).toBe(true);
    expect(button('Clipboard').disabled).toBe(true);
    expect(button('Disconnect').disabled).toBe(false);
  });

  it('intersects keyboard focus with the permission policy', async () => {
    const setEnabled = vi.spyOn(KeyboardInput.prototype, 'setEnabled');
    const { root } = renderViewer({ autoConnect: true });

    await connected();
    const lastEnabled = (): boolean | undefined =>
      setEnabled.mock.calls.at(-1)?.[0];
    await waitFor(() => expect(lastEnabled()).toBe(false));

    act(() => {
      root().focus();
      fireEvent.focusIn(root());
    });
    await waitFor(() => expect(lastEnabled()).toBe(true));

    act(() => {
      emit('permission', {
        ...ALL_ALLOWED,
        policy: { ...ALL_ALLOWED.policy, keyboard: false },
        permissions: { ...ALL_ALLOWED.permissions, keyboard: false },
        change: { permission: 'keyboard', enabled: false },
      });
    });
    await waitFor(() => expect(lastEnabled()).toBe(false));

    act(() => {
      emit('permission', ALL_ALLOWED);
      root().blur();
      fireEvent.focusOut(root());
    });
    await waitFor(() => expect(lastEnabled()).toBe(false));
  });

  it('shows a manual copy button when auto-copy is unavailable', async () => {
    const onClipboard = vi.fn();
    const copy = vi
      .spyOn(RustDeskSession.prototype, 'copyRemoteText')
      .mockResolvedValue(true);
    renderViewer({ autoConnect: true, onClipboard });

    await waitFor(() => expect(session).toBeDefined());
    act(() => {
      emit('clipboard', { text: 'hello', copied: false });
    });

    expect(onClipboard).toHaveBeenCalledWith('hello');
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull(),
    );
  });

  it('shows a peer close reason and reconnects from Connect', async () => {
    const connect = vi.mocked(RustDeskSession.prototype.connect);
    connect.mockImplementation(function (this: RustDeskSession) {
      session = this;
      return Promise.resolve(PEER);
    });
    renderViewer({ autoConnect: true });
    await connected();

    act(() => {
      emit('status', { status: 'disconnected', detail: 'maintenance' });
    });

    await screen.findByText('Disconnected');
    expect(screen.getByText('maintenance')).toBeTruthy();
    fireEvent.click(button('Connect'));
    await waitFor(() => expect(connect.mock.calls.length).toBe(2));
  });

  it('shows a typed error and reconnects from the retry button', async () => {
    let calls = 0;
    const connect = vi.mocked(RustDeskSession.prototype.connect);
    connect.mockImplementation(function (this: RustDeskSession) {
      session = this;
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new RustDeskError('peer-offline', 'Peer offline'));
      }
      return new Promise<PeerInfo>(() => {});
    });
    const onError = vi.fn();
    renderViewer({ autoConnect: true, onError });

    await waitFor(() => expect(session).toBeDefined());
    act(() => {
      emit('error', new RustDeskError('peer-offline', 'Peer offline'));
      emit('status', { status: 'error', detail: 'Peer offline' });
    });

    await waitFor(() => expect(onError).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText('Peer offline')).toBeTruthy(),
    );
    // Let the hook's rejected auto-connect clear its in-flight promise.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(button('Retry'));
    await waitFor(() => expect(connect.mock.calls.length).toBe(2));
  });

  it('disposes the renderer, controls and hidden input on unmount', async () => {
    const rendererDispose = vi.spyOn(VideoRenderer.prototype, 'dispose');
    const sessionDispose = vi.spyOn(RustDeskSession.prototype, 'dispose');
    const { container } = renderViewer({ autoConnect: true });
    await waitFor(() => expect(session).toBeDefined());

    expect(container.querySelector('textarea')).not.toBeNull();
    cleanup();

    expect(rendererDispose).toHaveBeenCalled();
    expect(sessionDispose).toHaveBeenCalled();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('runs ref commands against the live session', async () => {
    const request = vi
      .spyOn(VideoRenderer.prototype, 'requestFullscreen')
      .mockResolvedValue(true);
    const exit = vi
      .spyOn(VideoRenderer.prototype, 'exitFullscreen')
      .mockResolvedValue();
    const focusIme = vi
      .spyOn(ImeInput.prototype, 'focus')
      .mockReturnValue(true);
    const connect = vi.mocked(RustDeskSession.prototype.connect);
    const { ref } = renderViewer({ autoConnect: false });

    expect(ref.current).not.toBeNull();
    await ref.current!.setFullscreen(true);
    await ref.current!.setFullscreen(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);

    // Not connected: forcing the keyboard is a no-op.
    ref.current!.focusKeyboard();
    expect(focusIme).not.toHaveBeenCalled();

    // The ref connect uses the hook's session (autoConnect is off here).
    void ref.current!.connect();
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(session).toBeDefined();

    await connected();
    await waitFor(() =>
      expect(document.querySelector('textarea')).not.toBeNull(),
    );
    ref.current!.focusKeyboard();
    expect(focusIme).toHaveBeenCalledTimes(1);
  });
});
