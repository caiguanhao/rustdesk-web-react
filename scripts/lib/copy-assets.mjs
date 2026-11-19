/**
 * Copy the vendored ogv VP9 decoder assets into a host app's public directory.
 * Used by the published `rustdesk-react copy-assets <publicDir>` bin.
 *
 * Files land in `<publicDir>/rustdesk-assets/`, which the viewer reaches via the
 * default `assetBaseUrl` (`/rustdesk-assets/`). Existing files with the same
 * names are overwritten; unrelated files in the destination are left alone.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, parse, resolve, sep } from 'node:path';
import { ASSET_DIR, verifyAssets } from './ogv-assets.mjs';

/**
 * @param {string} publicDirArg
 * @returns {{ dest: string, count: number, bytes: number, version: string }}
 */
export function copyAssets(publicDirArg) {
  const publicDir = resolve(process.cwd(), publicDirArg);
  const dest = join(publicDir, 'rustdesk-assets');
  if (
    publicDir === parse(publicDir).root ||
    dest === ASSET_DIR ||
    dest.startsWith(ASSET_DIR + sep)
  ) {
    throw new Error(`Refusing to copy assets into ${dest}`);
  }

  const { manifest, failures } = verifyAssets(ASSET_DIR);
  if (failures.length > 0) {
    throw new Error(
      `Asset check failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`,
    );
  }

  mkdirSync(dest, { recursive: true });
  let bytes = 0;
  for (const file of manifest.files) {
    copyFileSync(join(ASSET_DIR, file.name), join(dest, file.name));
    bytes += file.bytes;
  }
  copyFileSync(join(ASSET_DIR, 'manifest.json'), join(dest, 'manifest.json'));

  return {
    dest,
    count: manifest.files.length,
    bytes,
    version: manifest.version,
  };
}
