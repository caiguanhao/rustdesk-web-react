# rustdesk-web-react

**English** | [简体中文](README_CN.md)

A lightweight React + TypeScript library that embeds RustDesk remote screen viewing and
control into an existing React admin application.

> **Unofficial project**: This is an independent community implementation. It is not
> affiliated with, sponsored by, or endorsed by the RustDesk project. The `RustDesk`
> name is used only to describe protocol compatibility; all related trademarks belong
> to their respective owners.

- The host application supplies `server`, `serverKey`, `id`, and `password`; the library
  itself has no account system or device list.
- ✅ Supported: video + mouse/keyboard + iOS/Android touch + two-way text clipboard.
- ❌ Not supported: audio, multiple displays, file transfer.

## Quick start

Requirements: Node.js >= 20.19 and React 18/19; browsers must support WebSocket,
WebAssembly, and ES2020 (iOS 15+). This repository is currently `private: true` at
version `0.0.0` and has not been published to npm; consume it from the repository or
from a local tarball/workspace.

Build in the repository and copy the demo assets:

```bash
npm install
npm run build
npm run copy-assets          # demo: demo/public/rustdesk-assets/
```

After installing into a host project:

```bash
npx rustdesk-react copy-assets <host-public-dir>
```

Assets must be **same-origin** with the page (validated relative to `document.baseURI`;
pinning `base-uri 'self'` is recommended). The default `assetBaseUrl` is
`/rustdesk-assets/`.

The three most common combinations are below; `readOnly`, `onStatusChange`, `onError`,
and similar props are independent of the credential mode and can be added to any
example.

**Case 1: Fetch the serverKey from an authenticated API before connecting (recommended)**

`serverKey` never enters the static bundle; this suits a host admin that already has a
login session.

```tsx
import { RustDeskViewer } from 'rustdesk-web-react';

export function RemotePanel() {
  return (
    <RustDeskViewer
      server="rd.example.com"                 // or host:21116
      serverKeyProvider={async () => {
        const res = await fetch('/api/rustdesk/key', { credentials: 'include' });
        return res.ok ? (await res.json()).serverKey : undefined;
      }}
      id="123456789"
      passwordHash={passwordHash}             // base64(SHA256(password || salt))
      assetBaseUrl="/rustdesk-assets/"
      onStatusChange={(event) => console.log('status', event.status)}
      onError={(error) => console.warn('rustdesk', error.code, error.message)}
    />
  );
}
```

**Case 2: Static serverKey + password (optional)**

Suitable for simple deployments. If `password` is omitted or empty, the viewer prompts
for it; passing a plaintext password puts it in the frontend code or build output, so
use that only for controlled/internal pages. The remaining examples omit `import` and
the outer component and show only the props.

```tsx
<RustDeskViewer
  server="rd.example.com"                   // or host:21116
  serverKey="<hbbs base64 public key>"
  id="123456789"
  password="<device password>"              // optional; a prompt appears if empty
  assetBaseUrl="/rustdesk-assets/"
/>
```

**Case 3: Signed envelope serverKeyVerifier + passwordHash**

Compatible with the official web client verifier; the host backend generates the signed
envelope.

```tsx
<RustDeskViewer
  server="rd.example.com"
  serverKeyVerifier={{ publicKey, verifier }}
  id="123456789"
  passwordHash={passwordHash}
/>
```

`serverKey` / `serverKeyProvider` / `serverKeyVerifier` determine the key source, while
the built-in form / `password` / `passwordHash` determine the password source; the two
are independent and can be combined.

**How `passwordHash` is generated**

`passwordHash` is RustDesk's `h1` (a 32-byte digest, supplied as base64), computed from
the controlled device's `Hash.salt` and the device password (the two are concatenated
directly, with no separator):

```text
h1 = base64( SHA256( UTF8(password) || UTF8(salt) ) )
```

At login the library only computes `SHA256(h1 || UTF8(challenge))` locally and sends
that to the peer; `h1` itself never goes over the network. When you pass a plaintext
`password`, the library uses the same formula internally; `passwordHash` simply moves
that step to the host side. You can also pass `{ hash, salt }`: when `salt` is present,
the library compares it with the peer's `Hash.salt` first and asks for the password
again if they differ.

`salt` is not a secret key, but it must match the controlled device. Copy `salt = "..."`
from the controlled device's `RustDesk.toml`:

- macOS: `~/Library/Preferences/com.carriez.RustDesk/RustDesk.toml`
- Linux: `~/.config/rustdesk/RustDesk.toml`

Host backend example (Node.js):

```ts
import { createHash } from 'node:crypto';

const passwordHash = createHash('sha256')
  .update(password, 'utf8')
  .update(salt, 'utf8')
  .digest('base64');
```

`h1` is equivalent to a login credential for that device, and `salt` is public, so weak
passwords can be guessed offline. Do not put h1/passwords in URLs, localStorage, or
logs. The `serverKeyVerifier` payload is plaintext `1000::<serverKey>`; the signature
only provides integrity, and the browser can still recover the key. To actually hide
the key from the browser, terminate the connection at a server-side gateway.

Headless (bring your own UI): import `RustDeskSession` from `rustdesk-web-react/core`;
see [docs/API.md](docs/API.md#rustdesksession) for the full signatures and events of
`connect`/`setVideoSink`/`on`/`bindInputs`.

Demo (repository checkout only): `npm run dev` opens the form; the `VITE_RD_*` template
is in `demo/.env.example`, with usage in `demo/README.md`. Do not commit
`demo/.env.local`.

Detailed documentation (currently in Chinese):

| Document | Contents |
| --- | --- |
| [docs/API.md](docs/API.md) | Viewer props/ref/labels, hook, Session, config, events, error codes, limits |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Ports/URLs, nginx/Caddy reverse proxy, HTTP/HTTPS/LAN, asset copying, CSP, server key, timeouts |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Troubleshooting by stage, error code, reverse proxy, assets, and mobile |
| [docs/AGPL.md](docs/AGPL.md) | Reused sources, NOTICE, source availability, and host obligations |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Initial JS/asset budgets, startup/first-frame/FPS/memory measurements and methodology |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Development status, public API entry points, phased implementation notes, tests/acceptance, and local dev environment |
| [demo/README.md](demo/README.md) | Demo form, env template, persistence, and password hygiene |

## License and source

Original code in this project is provided under **AGPL-3.0-or-later**; the reused
RustDesk web client protocol/keymap files are **AGPL-3.0 (only; no or-later grant was
confirmed in the upstream snapshot)**, so combined distribution must comply with
AGPL-3.0. Keep LICENSE/NOTICE and provide the Corresponding Source under AGPL §4–§6
(and §13 when you modify it and let users interact with it over a network). See
**[docs/AGPL.md](docs/AGPL.md)** for the complete packaging list, provenance, and host
obligations; dependency licenses are in `THIRD_PARTY_NOTICES.md`. This is not legal
advice.
