import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// The demo consumes the library through its public entry points, exactly like
// a host application would.
export default defineConfig({
  root: here('.'),
  plugins: [react()],
  resolve: {
    alias: [
      { find: 'rustdesk-web-react/core', replacement: here('../src/core.ts') },
      { find: 'rustdesk-web-react', replacement: here('../src/index.ts') },
    ],
  },
});
