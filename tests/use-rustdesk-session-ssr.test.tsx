// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { useRustDeskSession } from '../src/react/useRustDeskSession';
import type { RustDeskSessionConfig } from '../src/session/options';

// P4-2 SSR acceptance: rendering the hook on the server must not create a
// session, touch the DOM, or crash; effects only run on the client.

const config: RustDeskSessionConfig = {
  server: 'rd.example.com',
  id: '123456789',
  password: 'secret',
};

describe('useRustDeskSession SSR', () => {
  it('renders idle without creating a session', () => {
    const createSession = vi.fn();
    function Probe() {
      const { status, session } = useRustDeskSession(config, {
        autoConnect: true,
        createSession,
      });
      return (
        <p>
          {status}:{session ? 'session' : 'none'}
        </p>
      );
    }

    const html = renderToString(<Probe />);

    expect(html).toContain('idle');
    expect(html).toContain('none');
    expect(html).not.toContain('session');
    expect(createSession).not.toHaveBeenCalled();
  });
});
