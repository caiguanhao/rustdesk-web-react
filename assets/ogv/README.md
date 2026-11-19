# ogv.js VP9 decoder assets

Vendored subset of [ogv.js](https://github.com/brion/ogv.js) 1.8.6, copied from the
`rustdesk-web-v1` branch of the reference checkout (`ogvjs-1.8.6/`).

RustDesk peers are forced to VP9 because we never send `supported_decoding`, so only
the worker-based VP9 decoder pair (SIMD and non-SIMD) is shipped. There are no
demuxers, no audio decoders and no other video codecs.

- `ogv.js` — UMD loader that exposes `OGVLoader`
- `ogv-worker-video.js` — worker shim loaded by `OGVLoader` (`worker: true`)
- `ogv-decoder-video-vp9-wasm.{js,wasm}` — non-SIMD fallback (iOS < 16.4)
- `ogv-decoder-video-vp9-simd-wasm.{js,wasm}` — SIMD path, chosen via `wasm-feature-detect`
- `COPYING`, `LICENSE-vpx.txt`, `PATENTS-vpx.txt` — MIT / libvpx licenses; keep them
  next to the assets when copying them into an app.

`manifest.json` records sizes and SHA-256 of every file; `scripts/check-size.mjs`
verifies it and enforces the asset budget, and
`node scripts/copy-assets.mjs <publicDir>` copies the files into
`<publicDir>/rustdesk-assets/` — the location behind the default
`assetBaseUrl` (`/rustdesk-assets/`).

Update procedure: download the matching files from the ogv.js 1.8.6 release (or a
newer release after reviewing the changelog), refresh `manifest.json`, then run
`npm run check-size`.
