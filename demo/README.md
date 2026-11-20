# Demo

From the repository root, `npm run dev` starts this Vite app and (via `predev`)
copies the VP9 assets to `demo/public/rustdesk-assets/`. Open the printed URL,
fill the form and press Connect. The page embeds `<RustDeskViewer autoConnect />`;
the viewer owns the canvas, overlays, toolbar and input wiring. The
viewer/protocol/renderer code is lazy-loaded after Connect, so the form itself
stays light. A generated `<RustDeskViewer />` snippet at the bottom follows the
selected credential mode.

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

Fields: Credential mode, Server, Server Key, Password, Relay (optional),
Device ID, Asset Base URL, plus hash-mode fields:

- **Plaintext password**: password is passed to the viewer directly.
- **passwordHash + serverKeyVerifier**: enter Password + Password Salt and
  click **Get passwordHash + serverKeyVerifier**. The Vite dev/preview
  middleware (`/api/rustdesk/credential`) computes
  `base64(SHA256(UTF8(password) || UTF8(salt)))` and signs
  `"1000::<serverKey>"` with a fresh Ed25519 keypair. The response fills the
  read-only Password Hash / Verifier Public Key / Verifier fields, and Connect
  uses those fetched values.

  The Salt is the controlled device's `Hash.salt`. Copy `salt = "..."` from
  its `RustDesk.toml`:

  | Platform | Path |
  | --- | --- |
  | macOS | `~/Library/Preferences/com.carriez.RustDesk/RustDesk.toml` |
  | Linux | `~/.config/rustdesk/RustDesk.toml` |
  | Linux root/service | `/root/.config/rustdesk/RustDesk.toml` |
  | Linux Flatpak | `~/.var/app/com.rustdesk.RustDesk/config/rustdesk/RustDesk.toml` |
  | Windows | `%APPDATA%\RustDesk\config\RustDesk.toml` |

`VITE_RD_*` values are first-run defaults:

| Variable | Meaning |
| --- | --- |
| `VITE_RD_CREDENTIAL_MODE` | `password` (default) or `hash` |
| `VITE_RD_SERVER` | hbbs host or `host:port` |
| `VITE_RD_KEY` | hbbs Ed25519 public key (base64), self-hosted |
| `VITE_RD_SALT` | peer `Hash.salt`; copy `salt = "..."` from `RustDesk.toml` (paths above) |
| `VITE_RD_RELAY` | optional relay override |
| `VITE_RD_ID` | remote device ID |
| `VITE_RD_PASSWORD` | optional local password prefill |
| `VITE_RD_ASSET_BASE` | decoder asset base URL; empty uses the viewer's default `/rustdesk-assets/` |

Copy `demo/.env.example` to `demo/.env.local` and edit it locally. The whole
`demo/.env*` family is gitignored (`demo/.env.example` is the only committed
one) because it may contain a remote-device password. Never commit a real
password or server key.

## Persistence and credential handling

- On Connect, all form fields **except Password** are saved under
  `localStorage['rustdesk-web-react.demo.form.v1']`; on the next page load they
  override the `VITE_RD_*` defaults. This includes Server Key and Salt. Clear
  that key in DevTools to go back to the env defaults. The save/load field list
  is one constant; the password and the fetched hash/verifier are outside it.
- The viewer chunk (and its protocol/renderer dependencies) loads on Connect,
  not with the initial form.
- Password and the fetched hash/verifier are React state only. They are never
  written to localStorage, the URL or the console, and the demo does not log
  connection configs. After submit the password is cleared from the form; the
  viewer keeps the submitted credential in its session config. "Change
  settings" unmounts the viewer, disposes the session and clears the fetched
  credential (unless `VITE_RD_PASSWORD` prefills the password on the next load).
- Leave Password empty in plaintext mode to let the viewer's built-in prompt
  (or a host's `onPasswordRequired`) ask for it. Wrong-password retries stay on
  the same connection/Hash. Hash mode requires a password, Salt, and a fetched
  credential before Connect.
- Hash mode calls the local Vite dev/preview API
  `/api/rustdesk/credential`. It is a demo stand-in for a real backend: the API
  receives the plaintext password over localhost, computes the h1 from the
  supplied Salt, and returns `{ passwordHash, serverKeyVerifier }`. It is not
  part of the static build and must not be used in production. The verifier is
  a signed encoding, not encryption: its payload is plaintext and can be
  decoded by the browser.
- The generated snippet at the bottom of the page shows the selected mode with
  server/id/verifier values. In plaintext mode the password stays a
  placeholder; in hash mode, after **Get passwordHash + serverKeyVerifier**,
  the snippet contains the fetched h1 and verifier. Treat that snippet as a
  credential.

## Network, assets and troubleshooting

The demo only passes the form values to the viewer. For the host-integration
rules — HTTP vs HTTPS/WSS, `host:port` +2/+3 port shifts, reverse-proxy paths,
LAN reachability, mixed content, secure-context clipboard, CSP and
`assetBaseUrl` — use the canonical [deployment guide](../docs/DEPLOYMENT.md).
Error codes and proxy/asset diagnostics are in
[TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md).

Demo-specific notes:

- The Vite page is plain HTTP, so the demo uses `ws://`; for a LAN demo allow
  the hbbs/hbbr WebSocket ports (or put them behind the same TLS proxy).
- HTTP is not a secure context, so `navigator.clipboard` is unavailable. The
  viewer falls back to `document.execCommand('copy')` for manual copies and
  shows a paste field (long-press → Paste → Send) for local→remote text.
- Leave `Asset Base URL` empty to use the viewer's default `/rustdesk-assets/`;
  `predev` copies the assets into `demo/public/rustdesk-assets/`.

## Diagnostics

- Append `?simd=0` or `?simd=1` to force the non-SIMD/SIMD VP9 decoder. Used
  by the P5-1/P5-2 checklist to cover the iOS 15/16.3 path on newer phones.
- `/ime-events.html` logs `keydown`/`beforeinput`/`input`/composition events
  from a library-shaped hidden textarea. Use it to capture third-party IME
  behavior (e.g. Android SwiftKey) when input mapping misbehaves.
