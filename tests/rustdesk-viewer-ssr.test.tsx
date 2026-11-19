// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The viewer must be renderable by a host's SSR pass: no effects run, so no
// session/socket, renderer or DOM access; the first paint is the idle shell.
vi.mock('yuv-canvas', async () => import('./mocks/fake-yuv-canvas'));

import { RustDeskViewer } from '../src/react/RustDeskViewer';

describe('RustDeskViewer SSR', () => {
  it('renders the idle shell without creating a session', () => {
    const html = renderToString(
      <RustDeskViewer
        server="rd.example.com"
        serverKey="base64-key"
        id="123456789"
        autoConnect
      />,
    );

    expect(html).toContain('data-rustdesk-viewer');
    expect(html).toContain('data-status="idle"');
    expect(html).toContain('data-rustdesk-canvas');
    expect(html).toContain('data-rustdesk-toolbar');
    expect(html).toContain('Connect');
  });
});
