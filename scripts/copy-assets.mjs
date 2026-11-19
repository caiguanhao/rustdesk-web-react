#!/usr/bin/env node
/**
 * Copy the vendored ogv VP9 decoder assets into a host app's public directory:
 *
 *   node scripts/copy-assets.mjs <publicDir>
 *
 * Files land in `<publicDir>/rustdesk-assets/`, which the viewer reaches via the
 * default `assetBaseUrl` (`/rustdesk-assets/`). Existing files with the same
 * names are overwritten; unrelated files in the destination are left alone.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAssets } from './lib/ogv-assets.mjs';

const assetDir = fileURLToPath(new URL('../assets/ogv/', import.meta.url));
const publicDirArg = process.argv[2];
if (!publicDirArg) {
  console.error('Usage: node scripts/copy-assets.mjs <publicDir>');
  process.exit(1);
}

const publicDir = resolve(process.cwd(), publicDirArg);
const dest = join(publicDir, 'rustdesk-assets');
if (publicDir === parse(publicDir).root || dest === assetDir || dest.startsWith(assetDir + sep)) {
  console.error(`Refusing to copy assets into ${dest}`);
  process.exit(1);
}

const { manifest, failures } = verifyAssets(assetDir);
if (failures.length > 0) {
  console.error('Asset check failed; run npm run check-size for details:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
let bytes = 0;
for (const file of manifest.files) {
  copyFileSync(join(assetDir, file.name), join(dest, file.name));
  bytes += file.bytes;
}
copyFileSync(join(assetDir, 'manifest.json'), join(dest, 'manifest.json'));

console.log(
  `Copied ${manifest.files.length} ogv.js ${manifest.version} files (${(bytes / 1024).toFixed(1)} KiB) to ${dest}`,
);
