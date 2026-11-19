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
