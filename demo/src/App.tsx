import { VERSION } from 'rustdesk-web-react';

export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>rustdesk-web-react</h1>
      <p>
        Demo scaffold v{VERSION}. The connection form arrives in P1-9/P4-4.
      </p>
    </main>
  );
}
