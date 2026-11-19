#!/usr/bin/env node
/**
 * Measure the initial JS gzip size of the public root entry (P5-3).
 *
 * The spec budget is < 250 KiB gzip excluding React. This bundles src/index.ts
 * with Vite/Rollup, keeps React external, minifies, and sums the gzip size of
 * the entry chunk plus its static imports. Dynamic chunks (libsodium at
 * connect, zstddec for compressed clipboard) are intentionally excluded.
 *
 * Runs as part of `npm run check-size` (prebuild), so an accidental heavy
 * static import fails the build. Uses the dev-only Vite toolchain.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_BYTES = 250 * 1024;
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
// React is host-provided; the dynamic-only packages are deliberately not part
// of the first-screen bundle (libsodium at connect, zstddec for clipboard).
const externalNames = new Set([
  ...Object.keys(pkg.peerDependencies ?? {}),
  'libsodium-wrappers',
  'libsodium',
  'zstddec',
]);
const isExternal = (id) =>
  [...externalNames].some((name) => id === name || id.startsWith(`${name}/`));

const result = await build({
  configFile: false,
  root,
  logLevel: 'silent',
  build: {
    write: false,
    // Keep in sync with vite.config.ts (iOS 15 target).
    target: 'es2020',
    lib: {
      entry: resolve(root, 'src/index.ts'),
      formats: ['es'],
      fileName: 'entry',
    },
    rollupOptions: {
      external: isExternal,
    },
  },
});

const outputs = Array.isArray(result) ? result : [result];
const chunks = outputs
  .flatMap((output) => output.output)
  .filter((item) => item.type === 'chunk');
const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
const entry = chunks.find((chunk) => chunk.isEntry);
if (!entry) {
  console.error('JS size check failed: Vite produced no entry chunk');
  process.exit(1);
}

const initial = [];
const seen = new Set();
function visit(chunk) {
  if (!chunk || seen.has(chunk.fileName)) return;
  seen.add(chunk.fileName);
  initial.push(chunk);
  for (const imported of chunk.imports) visit(byFileName.get(imported));
}
visit(entry);

let total = 0;
for (const chunk of initial) {
  const gzip = gzipSync(Buffer.from(chunk.code), { level: 9 }).length;
  total += gzip;
  console.log(
    `  ${chunk.fileName.padEnd(36)} ${(gzip / 1024).toFixed(1).padStart(7)} KiB gzip`,
  );
}

console.log(
  `\nInitial JS (excluding React): ${(total / 1024).toFixed(1)} KiB gzip / ${(BUDGET_BYTES / 1024).toFixed(0)} KiB budget`,
);
if (total >= BUDGET_BYTES) {
  console.error(`JS size check failed: ${total} B >= ${BUDGET_BYTES} B`);
  process.exit(1);
}
console.log('Initial JS size OK');
