#!/usr/bin/env node
/**
 * Copy the AGPL/third-party notices into dist/notices, preserving their
 * repository-relative paths so the cross-references inside NOTICE,
 * THIRD_PARTY_NOTICES.md and docs/AGPL.md keep working for hosts that
 * distribute only the built output. Runs as npm's `postbuild` lifecycle hook.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_DIR, readManifest } from './lib/ogv-assets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dest = join(root, 'dist', 'notices');

const licenses = readManifest(ASSET_DIR).files
  .filter((file) => file.role === 'license')
  .map((file) => `assets/ogv/${file.name}`);

const files = [
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'docs/AGPL.md',
  'src/protocol/NOTICE.md',
  'src/input/NOTICE.md',
  ...licenses,
];

for (const source of files) {
  const target = join(dest, source);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, source), target);
}
console.log(`Copied ${files.length} license/notice files to ${dest}`);
