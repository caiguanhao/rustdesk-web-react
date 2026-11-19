// P4-3 browser acceptance: embed <RustDeskViewer/> in an ordinary host React
// page under StrictMode (the host's likely dev setup). autoConnect is off (no
// real server here), so this proves rendering, letterbox geometry, host
// labels/styling, read-only toolbar gating, StrictMode double-mount cleanup
// and that the surrounding page remains interactive in a real browser.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RustDeskViewer } from 'rustdesk-web-react';

function App() {
  const [clicks, setClicks] = useState(0);
  return (
    <main style={{ margin: 16 }}>
      <h1 style={{ fontSize: 18 }}>Host admin page</h1>
      <button id="host-button" type="button" onClick={() => setClicks((n) => n + 1)}>
        Host action
      </button>
      <span id="host-clicks">{clicks}</span>
      <section id="viewer-slot" style={{ width: 640, marginTop: 16 }}>
        <RustDeskViewer
          server="127.0.0.1:1"
          id="123456789"
          autoConnect={false}
          readOnly
          className="embedded-viewer"
          labels={{
            connect: 'Connect now',
            keyboard: 'Soft keyboard',
            clipboard: 'Copy clipboard',
          }}
        />
      </section>
      <p id="host-after">Host content after the viewer.</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
