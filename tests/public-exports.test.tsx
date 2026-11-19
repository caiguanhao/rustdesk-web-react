// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom has no drawable canvas; the viewer's renderer is exercised for real in
// the browser tests. Keep the structural sink shared with the viewer tests.
vi.mock('yuv-canvas', async () => import('./mocks/fake-yuv-canvas'));

import * as root from '../src/index';
import * as core from '../src/core';
import type {
  PeerInfo,
  RustDeskSessionConfig,
  RustDeskViewerProps,
  RustDeskViewerRef,
} from '../src/index';

// P0-4 acceptance: both entries expose a usable API surface and the React
// shell renders with host styling. P4-3 replaces the fail-loud ref stubs with
// commands that safely no-op when no session is connected.
afterEach(() => {
  cleanup();
});

describe('public exports', () => {
  const config: RustDeskSessionConfig = {
    server: 'rd.example.com',
    serverKey: 'base64-key',
    id: '123456789',
    assetBaseUrl: core.DEFAULT_ASSET_BASE_URL,
  };

  const props: RustDeskViewerProps = {
    ...config,
    autoConnect: false,
    labels: { connect: 'Connect' },
  };

  it('exposes shared runtime exports from both entry points', () => {
    expect(root.RustDeskError).toBe(core.RustDeskError);
    expect(typeof root.RustDeskViewer).toBe('object'); // forwardRef wrapper
    // The core entry must stay React-free: no viewer component is exported.
    expect(core).not.toHaveProperty('RustDeskViewer');
  });

  it('renders the embeddable layout shell with host styling', () => {
    const ref = createRef<RustDeskViewerRef>();
    const { container } = render(
      <root.RustDeskViewer
        {...props}
        ref={ref}
        className="host-viewer"
        style={{ height: 240 }}
      />,
    );

    const shell = container.querySelector('[data-rustdesk-viewer]');
    expect(shell).not.toBeNull();
    expect(shell?.getAttribute('data-status')).toBe('idle');
    expect(shell?.className).toBe('host-viewer');
    expect((shell as HTMLElement).style.height).toBe('240px');
    expect((shell as HTMLElement).style.aspectRatio).toContain('16');
  });

  it('exposes safe ref commands before a session is connected', async () => {
    const ref = createRef<RustDeskViewerRef>();
    const { container } = render(
      <root.RustDeskViewer {...props} ref={ref} />,
    );

    expect(container.querySelector('canvas')).not.toBeNull();
    const handle = ref.current;
    expect(handle).not.toBeNull();
    if (!handle) return;

    // autoConnect=false: these must not throw or start a connection.
    expect(() => handle.disconnect()).not.toThrow();
    expect(() => handle.sendCtrlAltDel()).not.toThrow();
    expect(() => handle.focusKeyboard()).not.toThrow();
    await expect(handle.setFullscreen(false)).resolves.toBeUndefined();
  });

  it('carries a stable code and optional cause on RustDeskError', () => {
    const cause = new Error('ws closed');
    const error = new root.RustDeskError('connection-lost', 'lost', { cause });
    expect(error.name).toBe('RustDeskError');
    expect(error.code).toBe('connection-lost');
    expect(error.cause).toBe(cause);
  });

  it('types the normalized PeerInfo shape', () => {
    const peer: PeerInfo = {
      username: 'alice',
      hostname: 'desktop',
      platform: 'Linux',
      displays: [{ x: 0, y: 0, width: 1920, height: 1080, name: 'DP-1', online: true }],
      currentDisplay: 0,
      sasEnabled: false,
      version: '1.5.3',
      connectionId: 42,
      privacyMode: false,
    };
    expect(peer.displays[0]?.width).toBe(1920);
  });
});
