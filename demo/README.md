# Demo

`npm run dev` starts this Vite app and (via `predev`) copies the VP9 assets to
`demo/public/rustdesk-assets/`. Open the printed URL, fill the form and press
Connect. The page embeds `<RustDeskViewer autoConnect />`; the viewer owns the
canvas, overlays, toolbar and input wiring. The viewer/protocol/renderer code
is lazy-loaded after Connect, so the form itself stays light.

```bash
npm run dev
# LAN/mobile (the page is then reachable at http://<your-ip>:5173):
npm run dev -- --host 0.0.0.0
```

Do not point this at the RustDesk client configuration on your own machine as
part of development. Use a test hbbs/hbbr and a controlled peer, or the
isolated environment in the root README (`npm run dev:server` / `npm run
dev:peer`).

## Form and environment

Fields: Server, Server Key, Relay (optional), Device ID, Password, Asset Base
URL. `VITE_RD_*` values are first-run defaults:

| Variable | Meaning |
| --- | --- |
| `VITE_RD_SERVER` | hbbs host or `host:port` |
| `VITE_RD_KEY` | hbbs Ed25519 public key (base64), self-hosted |
| `VITE_RD_RELAY` | optional relay override |
| `VITE_RD_ID` | remote device ID |
| `VITE_RD_PASSWORD` | optional local password prefill |
| `VITE_RD_ASSET_BASE` | decoder asset base URL; empty uses the viewer's default `/rustdesk-assets/` |

Copy `demo/.env.example` to `demo/.env.local` and edit it locally. The whole
`demo/.env*` family is gitignored (`demo/.env.example` is the only committed
one) because it may contain a remote-device password. Never commit a real
password or server key.

## Persistence and password handling

- On Connect, the five **non-password** fields are saved under
  `localStorage['rustdesk-web-react.demo.form.v1']`; on the next page load they
  override the `VITE_RD_*` defaults. Clear that key in DevTools to go back to
  the env defaults. The save/load field list is one constant; the password is
  outside it.
- The viewer chunk (and its protocol/renderer dependencies) loads on Connect,
  not with the initial form.
- The password is React state only. It is never written to localStorage, the
  URL or the console, and the demo does not log connection configs. After
  submit it is cleared from the form; the viewer keeps the submitted value in
  its session config. "Change settings" unmounts the viewer, disposes the
  session and returns to the form with an empty password (unless
  `VITE_RD_PASSWORD` prefills it on the next load).
- Leave the password empty to let the viewer's built-in prompt (or a host's
  `onPasswordRequired`) ask for it. Wrong-password retries stay on the same
  connection/Hash.

## HTTP, HTTPS and LAN

- The page protocol chooses the WebSocket scheme: an HTTPS page uses `wss://`,
  an HTTP page (including LAN) uses `ws://`.
- `Server` accepts `host` or `host:port`:
  - with an explicit port, the rendezvous WS port is `port + 2` and the
    fallback relay WS port is `port + 3` (e.g. `21116` → `21118` / `21119`);
  - on an HTTPS page without a port, the client uses the reverse-proxy path
    `wss://<host>/ws/id` (relay: `/ws/relay`).
- The browser must reach hbbs (WS, normally 21118) and hbbr (WS, normally
  21119), not just the UDP/TCP rendezvous ports. For a LAN demo, allow those
  ports or put both behind the same TLS reverse proxy.
- **Mixed content**: an HTTPS admin page cannot open a plain `ws://` socket.
  Use a valid TLS certificate + WSS reverse proxy, or open the demo over HTTP
  on a trusted network. The library rejects an explicit `ws://` URL on an
  HTTPS page with `invalid-config`.
- **Clipboard**: browsers expose the clipboard only in a secure context
  (HTTPS or `localhost`). On a plain-HTTP LAN page, remote video/input can
  still work, but auto-copy may be blocked; the viewer then shows its manual
  "Copy" button. Always click a control before granting clipboard access.
- **Assets**: `assetBaseUrl` must be same-origin (Workers/WASM). Leave the
  field empty to use the viewer's default `/rustdesk-assets/`. In a host app,
  copy `assets/ogv/` with the package's copy-assets command instead of the
  demo's Vite public directory; see the root README.

## Troubleshooting

- `asset-load-failed` / 404s: run `npm run copy-assets` (or use `npm run dev`,
  whose `predev` does it) and check `Asset Base URL`.
- Secure handshake errors: check `Server Key` (base64, from the same hbbs). A
  key mismatch fails closed unless the config opts into the insecure fallback.
- Stuck at connecting/securing: hbbs/hbbr WS ports are unreachable, the server
  has no peer with that Device ID, or the controlled peer has not registered.
  The Docker setup prints the expected ports/key at startup.
- Wrong password: the viewer shows the retry prompt/detail. It never puts the
  password in the URL or storage.
