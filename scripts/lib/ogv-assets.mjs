/**
 * Shared manifest verification for the vendored ogv VP9 assets. Used by
 * `check-size.mjs`, the copy-assets CLI and (indirectly) the test suite so the
 * size/SHA-256 rules exist once.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Normalized vendored asset directory; shared by all build/copy scripts. */
export const ASSET_DIR = resolve(
  fileURLToPath(new URL('../../assets/ogv/', import.meta.url)),
);

export function readManifest(assetDir) {
  return JSON.parse(readFileSync(join(assetDir, 'manifest.json'), 'utf8'));
}

/**
 * Check every manifest entry against disk and report files that exist in the
 * asset directory but are not listed (the whole directory is published in the
 * package, so strays must not slip past the budget unnoticed).
 *
 * @returns {{ manifest: object, rows: {name: string, role: string, bytes: number}[], total: number, failures: string[] }}
 */
export function verifyAssets(assetDir) {
  const manifest = readManifest(assetDir);
  const failures = [];
  const rows = [];
  let total = 0;

  for (const file of manifest.files) {
    let data;
    try {
      data = readFileSync(join(assetDir, file.name));
    } catch {
      failures.push(`${file.name}: missing`);
      continue;
    }
    if (data.byteLength !== file.bytes) {
      failures.push(`${file.name}: ${data.byteLength} bytes, manifest says ${file.bytes}`);
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (sha256 !== file.sha256) {
      failures.push(`${file.name}: sha256 ${sha256} != ${file.sha256}`);
    }
    total += data.byteLength;
    rows.push({ name: file.name, role: file.role, bytes: data.byteLength });
  }

  const listed = new Set(['manifest.json', 'README.md', ...manifest.files.map((file) => file.name)]);
  for (const entry of readdirSync(assetDir).sort()) {
    if (!listed.has(entry)) {
      failures.push(`${entry}: present in assets/ogv but not listed in manifest.json`);
    }
  }

  return { manifest, rows, total, failures };
}
