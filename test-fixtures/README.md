# Remote input test page

`remote-input-test.html` is a static page for exercising a real RustDesk
session. Open it on the **controlled** machine, focus it, and drive it from the
controller:

- coordinate grid with mouse move/down/up/wheel and touch logging,
- keyboard `code`/`key`/modifiers, IME composition and textarea input,
- paste and clipboard-read checks,
- an in-page event log.

To persist events for automated checks, run the local receiver:

```bash
npm run log-server   # 127.0.0.1:8787, writes .local/remote-input-events.jsonl
```

Then tick “POST events” on the page. The receiver binds loopback only and the
JSONL file is gitignored. Serving the page over HTTP (for example
`python3 -m http.server 8080 -d test-fixtures`) is recommended for clipboard
API permissions; `file://` still supports the event log and keyboard/mouse
tests.

# VP9 canvas fixtures

`vp9.ts` holds raw VP9 keyframes (base64) used by the browser check pages and
the Playwright canvas test. To regenerate one fixture:

```bash
ffmpeg -f lavfi -i color=c=green:size=64x64:rate=10 -frames:v 1 \
  -c:v libvpx-vp9 -lossless 1 -f ivf /tmp/green.ivf
# Strip the 32-byte IVF file header and 12-byte frame header:
node -e 'const b=require("fs").readFileSync("/tmp/green.ivf");console.log(b.subarray(44,44+b.readUInt32LE(32)).toString("base64"))'
```

The 64x64 size keeps the fixtures tiny; `demo/src/canvas-test.ts` resizes the
container to verify letterboxing. Paste the base64 into `VP9_FIXTURES`; the
Playwright test derives fixture names and dimensions from the same module.

`vp9-perf.ts` is a separate 1280x720 testsrc2 keyframe for P5-3
(`demo/perf-test.html` / `tests/e2e/perf.spec.ts`). It is synthetic and larger
(~76 KiB base64); it is not shipped and does not count toward the runtime
asset budget. Regenerate with the same two commands above, replacing the
`color=...:size=64x64` input with `testsrc2=size=1280x720` and writing the
base64 to `vp9-perf.ts`.

