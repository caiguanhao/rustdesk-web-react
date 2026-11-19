// P4-2 browser acceptance: mounts useRustDeskSession under StrictMode against
// a bare local WebSocket server. The server never completes the RustDesk
// handshake; the test only verifies that StrictMode's first session closes its
// socket, only one socket stays live, and unmount disposes the second.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  useRustDeskSession,
  type RustDeskSessionConfig,
} from 'rustdesk-web-react';

const params = new URLSearchParams(window.location.search);
const server = params.get('server') ?? '127.0.0.1:1';
const config: RustDeskSessionConfig = {
  server,
  id: '123456789',
  rendezvousUrl: `ws://${server}/ws/id`,
};

function Probe() {
  const { status } = useRustDeskSession(config);
  return <p id="status">{status}</p>;
}

function App() {
  const [mounted, setMounted] = useState(true);
  if (!mounted) return <p id="unmounted">unmounted</p>;
  return (
    <>
      <Probe />
      <button id="unmount" type="button" onClick={() => setMounted(false)}>
        unmount
      </button>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
