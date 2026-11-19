#!/usr/bin/env node
/**
 * rustdesk-react CLI.
 *
 *   rustdesk-react copy-assets <publicDir>
 *
 * Copies the vendored VP9 decoder assets to `<publicDir>/rustdesk-assets/`.
 * The CLI is deliberately explicit (no postinstall side effect); the assets
 * must be served same-origin and the viewer defaults to `/rustdesk-assets/`.
 */
import { parseArgs } from 'node:util';
import { copyAssets } from '../scripts/lib/copy-assets.mjs';

const USAGE = `Usage: rustdesk-react copy-assets <publicDir>

Copies the VP9 decoder assets to <publicDir>/rustdesk-assets/.
Serve that directory from the site root and keep assetBaseUrl at its default
(/rustdesk-assets/) or set it to the same-origin path you serve.`;

try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(USAGE);
  } else if (positionals[0] !== 'copy-assets' || positionals.length !== 2) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    const result = copyAssets(positionals[1]);
    console.log(
      `Copied ${result.count} ogv.js ${result.version} files (${(result.bytes / 1024).toFixed(1)} KiB) to ${result.dest}`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(USAGE);
  process.exitCode = 1;
}
