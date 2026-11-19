import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const pkg = JSON.parse(readFileSync(here('./package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

// Runtime dependencies stay external so the library bundle only ships our own
// code; consumers resolve them from the package dependencies (libsodium is
// imported dynamically at connect time). Deriving the list from package.json
// keeps the two in sync.
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

export default defineConfig({
  // The library ships assets explicitly (P0-3); never copy a stray public/.
  publicDir: false,
  build: {
    // Support the oldest browser in the plan (iOS 15, P5-1); Vite 8 otherwise
    // defaults to Safari 16.4+.
    target: 'es2020',
    lib: {
      entry: {
        index: here('./src/index.ts'),
        core: here('./src/core.ts'),
      },
      formats: ['es'],
    },
    sourcemap: true,
    rollupOptions: {
      external: (id) => external.some((name) => id === name || id.startsWith(`${name}/`)),
      output: {
        // Mirror the source tree in dist so the two entry points share code
        // without emitting content-hashed chunks (stable import paths).
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  },
});
