# Third-party notices

The original code of `rustdesk-web-react` is offered under AGPL-3.0-or-later;
the vendored RustDesk web-client protocol/keymap files are AGPL-3.0 only (see
`LICENSE`, `NOTICE`, and `docs/AGPL.md`). Its runtime dependencies are installed
by the host application; this file records their licenses and attributions. The full license text for each
dependency is normally in that package's `LICENSE` file in `node_modules/`, with
the exceptions noted below (yuv-canvas ships no license file, and ogv.js uses
the files under `assets/ogv/`).

| Component | Version | License | Attribution / notes |
| --- | --- | --- | --- |
| `libsodium-wrappers` / `libsodium` | 0.8.4 | ISC | Copyright (c) 2015-2026 Ahmad Ben Mrad, Frank Denis, Ryan Lester. |
| `protobufjs` | 8.8.1 | BSD-3-Clause | Copyright Daniel Wirtz; see the package `LICENSE`. |
| `long` | 5.3.2 | Apache-2.0 | Copyright Daniel Wirtz; see the package `LICENSE`. |
| `fast-sha256` | 1.3.0 | Unlicense | Public domain dedication; see the package `LICENSE`. |
| `wasm-feature-detect` | 1.10.1 | Apache-2.0 | Author Surma; see the package `LICENSE`. |
| `zstddec` | 0.0.2 | MIT AND BSD-3-Clause | MIT for Don McCurdy and BSD-3-Clause for Zstandard (Yann Collet / Facebook). Texts below. |
| `yuv-canvas` | 1.2.6 | MIT | Copyright 2014-2019 Brion Vibber. The npm package ships no license file; text below. |
| `react` / `react-dom` (peer) | 18/19 | MIT | Installed by the host; not conveyed by this package. |
| ogv.js | 1.8.6 | MIT (wrapper) + BSD-3-Clause (libvpx) + patent grant | Files under `assets/ogv/`: `COPYING`, `LICENSE-vpx.txt`, `PATENTS-vpx.txt`. The minified loader references an absent `ogv.js.LICENSE.txt`; those three files are the authoritative notices. |
| Oxc-generated runtime helpers (`dist/_virtual/...`) | 0.156.0 | MIT | Copyright (c) 2024-present VoidZero Inc. & Contributors; Copyright (c) 2023 Boshen. Shipped as part of `dist/`; MIT terms below. |
| `@oxc-project/types` (build-only) | 0.156.0 | MIT | Copyright (c) 2024-present VoidZero Inc. & Contributors; Copyright (c) 2023 Boshen. |

## zstddec — MIT

```text
The MIT License (MIT)

Copyright (c) 2020 Don McCurdy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## zstddec — Zstandard BSD-3-Clause

```text
BSD License

For Zstandard software

Copyright (c) 2016-present, Yann Collet, Facebook, Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

 * Redistributions of source code must retain the above copyright notice, this
 list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above copyright notice,
 this list of conditions and the following disclaimer in the documentation
 and/or other materials provided with the distribution.

 * Neither the name Facebook nor the names of its contributors may be used to
 endorse or promote products derived from this software without specific
 prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## yuv-canvas — MIT

```text
MIT License

Copyright (c) 2014-2019 Brion Vibber

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Oxc-generated runtime helpers — MIT

```text
Copyright (c) 2024-present VoidZero Inc. & Contributors
Copyright (c) 2023 Boshen

The MIT permission terms reproduced in the yuv-canvas section above apply to
these helper modules.
```

## ogv.js / libvpx

The decoder assets are copied verbatim from ogv.js 1.8.6. Their notices are
shipped next to the assets and are also copied into `dist/notices/` by the
build:

- `assets/ogv/COPYING` — ogv.js wrapper (MIT)
- `assets/ogv/LICENSE-vpx.txt` — libvpx (BSD-3-Clause)
- `assets/ogv/PATENTS-vpx.txt` — libvpx patent grant

Do not remove these files when copying the assets to a host app; the
`rustdesk-react copy-assets` command includes them.
