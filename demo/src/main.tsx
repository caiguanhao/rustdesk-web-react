import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './demo.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('demo: missing #root element');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
