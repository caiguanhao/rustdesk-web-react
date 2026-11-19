#!/usr/bin/env node
/**
 * Verify the vendored decoder assets against assets/ogv/manifest.json and
 * enforce the total-asset budget from the spec (P5-3: < 1.5 MB).
 *
 * Run by `npm run build` (prebuild) and by the asset test. Exits non-zero on
 * any missing file, size/hash mismatch, stray file, or budget overrun.
 */
import { ASSET_DIR, verifyAssets } from './lib/ogv-assets.mjs';

const BUDGET_BYTES = 1.5 * 1024 * 1024;
const { manifest, rows, total, failures } = verifyAssets(ASSET_DIR);

const width = Math.max(...rows.map((row) => row.name.length), 4);
console.log(`${manifest.name} ${manifest.version} (${manifest.source})`);
for (const row of rows) {
  console.log(
    `  ${row.name.padEnd(width)}  ${row.role.padEnd(12)}  ${String(row.bytes).padStart(8)} B`,
  );
}
console.log(
  `  ${'total'.padEnd(width)}  ${''.padEnd(12)}  ${String(total).padStart(8)} B  budget ${BUDGET_BYTES} B (${((total / BUDGET_BYTES) * 100).toFixed(1)}%)`,
);

if (total >= BUDGET_BYTES) {
  failures.push(`total ${total} B exceeds asset budget ${BUDGET_BYTES} B`);
}
if (failures.length > 0) {
  console.error('\nAsset check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nAsset check OK');
