/**
 * Pre-generated raw VP9 keyframes for the browser/Playwright canvas checks.
 *
 * Each entry is a single 64x64 lossless keyframe produced by:
 *   ffmpeg -f lavfi -i color=c=<color>:size=64x64:rate=10 -frames:v 1 \
 *     -c:v libvpx-vp9 -lossless 1 -f ivf /tmp/frame.ivf
 * and then stripping the 32-byte IVF file header and 12-byte frame header.
 * See README.md next to this file for the extraction command.
 */
export interface Vp9Fixture {
  name: string;
  width: number;
  height: number;
  keyframeBase64: string;
}

export const VP9_FIXTURES: Vp9Fixture[] = [
  {
    name: 'red-64x64',
    width: 64,
    height: 64,
    keyframeBase64:
      'gkmDQgAD8AP2ADgkHBgAAAAgAAB4uf///I14Ax////7PyHD////2yMAzNYhIAA==',
  },
  {
    name: 'green-64x64',
    width: 64,
    height: 64,
    keyframeBase64:
      'gkmDQgAD8AP2ADgkHBgAAAAgAAB4uf///I14Ax////7A4HD////ka8MzWISA',
  },
];
