/**
 * Rendezvous/relay WebSocket URL construction.
 *
 * Mirrors the official web client v2 `getUriFromRs` (rustdesk-web-v2
 * `js/dist/index.js`):
 *
 * - HTTPS page and a server without a port: path mode through the reverse
 *   proxy, `wss://<host>/ws/id` / `wss://<host>/ws/relay`.
 * - Any server with a port: connect directly and shift the port by +2
 *   (rendezvous) or +3 (fallback relay) / +`roffset` (hbbr from
 *   `RelayResponse` uses 2, so 21117 → 21119).
 * - HTTP page without a port: default 21116 shifts to 21118 / 21119.
 *
 * v1 simplified this by always using path mode on HTTPS, which breaks
 * non-standard reverse proxies and explicit ports; this module follows v2.
 *
 * `rendezvousUrl`/`relayUrl` config overrides are validated here and returned
 * unchanged. Web Workers/WASM need same-origin only for assets; WebSockets may
 * legitimately point elsewhere, so no origin restriction is applied.
 */
import { RustDeskError } from '../session/errors.js';

/** RustDesk's default hbbs TCP/WS port. */
export const DEFAULT_ID_SERVER_PORT = 21116;

export interface UrlContext {
  /**
   * Whether the page is served over HTTPS. Defaults to
   * `window.location.protocol === 'https:'`; pass explicitly in tests/Node.
   */
  secure?: boolean;
}

export interface RendezvousUrlOptions extends UrlContext {
  /** hbbs host (`host` or `host:port`). */
  server: string;
  /** Explicit `ws(s)://` rendezvous URL; wins over `server`. */
  rendezvousUrl?: string;
}

export interface RelayUrlOptions extends UrlContext {
  /** hbbs host (`host` or `host:port`). */
  server: string;
  /**
   * Effective relay host: `RelayResponse.relay_server` when present, else the
   * host-app `relayServer` option. Uses hbbr offset +2.
   */
  relayServer?: string;
  /** Explicit `ws(s)://` relay URL; wins over every other source. */
  relayUrl?: string;
}

function isHttpsPage(): boolean {
  return typeof window !== 'undefined' && window.location?.protocol === 'https:';
}

function isSecure(context: UrlContext): boolean {
  return context.secure ?? isHttpsPage();
}

function invalidConfig(message: string): never {
  throw new RustDeskError('invalid-config', message);
}

interface HostAndPort {
  host: string;
  port?: number;
}

/**
 * Parse `host` / `host:port` / `[ipv6]` / `[ipv6]:port`. The official client
 * simply splits on `:`, which cannot represent IPv6; bracket parsing is a
 * strict superset for valid host inputs.
 */
function splitHostPort(uri: string): HostAndPort {
  const value = uri.trim();
  if (value === '') invalidConfig('server is required');
  if (/[\s/?#]/.test(value)) {
    invalidConfig(`server must be a host or host:port, got "${value}"`);
  }

  let host: string;
  let portText: string | undefined;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) invalidConfig(`invalid IPv6 host "${value}"`);
    host = value.slice(0, end + 1);
    const rest = value.slice(end + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) invalidConfig(`invalid host "${value}"`);
      portText = rest.slice(1);
    }
  } else {
    const colon = value.lastIndexOf(':');
    if (colon < 0) {
      host = value;
    } else if (value.indexOf(':') !== colon) {
      // Bare IPv6 without a port; keep it whole, but reject other colon soup.
      if (!/^[0-9A-Fa-f:.%]+$/.test(value)) invalidConfig(`invalid host "${value}"`);
      host = value;
    } else {
      host = value.slice(0, colon);
      portText = value.slice(colon + 1);
    }
  }

  if (host === '' || host === '[]') invalidConfig(`invalid host "${value}"`);
  if (portText === undefined) return { host };

  if (!/^\d+$/.test(portText)) invalidConfig(`invalid port in "${value}"`);
  const port = Number(portText);
  if (port < 1 || port > 65535) invalidConfig(`port out of range in "${value}"`);
  return { host, port };
}

function hostForUrl(host: string): string {
  // Bracket the IPv6 literals that `splitHostPort` accepted without brackets.
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Official v2 `getUriFromRs`. `roffset` applies only when `isRelay` and the
 * input has an explicit port; 0 falls back to +3, matching RustDesk.
 */
export function getUriFromRs(
  uri: string,
  isRelay = false,
  roffset = 0,
  context: UrlContext = {},
): string {
  const secure = isSecure(context);
  const scheme = secure ? 'wss://' : 'ws://';
  const { host, port } = splitHostPort(uri);

  if (secure && port === undefined) {
    return `${scheme}${hostForUrl(host)}/ws/${isRelay ? 'relay' : 'id'}`;
  }

  const targetPort =
    port === undefined
      ? DEFAULT_ID_SERVER_PORT + (isRelay ? 3 : 2)
      : port + (isRelay ? roffset || 3 : 2);
  return `${scheme}${hostForUrl(host)}:${targetPort}`;
}

function explicitUrl(value: string, kind: 'rendezvous' | 'relay', secure: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidConfig(`${kind} URL is not a valid absolute URL: "${value}"`);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    invalidConfig(`${kind} URL must use ws:// or wss://, got ${url.protocol}`);
  }
  if (secure && url.protocol === 'ws:') {
    invalidConfig(`${kind} URL uses ws:// on an HTTPS page (mixed content)`);
  }
  if (url.hostname === '') invalidConfig(`${kind} URL has no host: "${value}"`);
  return value;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Rendezvous URL for the hbbs connection. `rendezvousUrl` overrides `server`.
 */
export function resolveRendezvousUrl(options: RendezvousUrlOptions): string {
  const context = { secure: isSecure(options) };
  const override = trimmedOrUndefined(options.rendezvousUrl);
  if (override) {
    return explicitUrl(override, 'rendezvous', context.secure);
  }
  return getUriFromRs(options.server, false, 0, context);
}

/**
 * Relay URL priority: explicit `relayUrl` > `relayServer` (+2) > hbbs host
 * (+3 fallback). P1-6 passes `RelayResponse.relay_server` as `relayServer`.
 */
export function resolveRelayUrl(options: RelayUrlOptions): string {
  const context = { secure: isSecure(options) };
  const override = trimmedOrUndefined(options.relayUrl);
  if (override) {
    return explicitUrl(override, 'relay', context.secure);
  }
  const relayServer = trimmedOrUndefined(options.relayServer);
  if (relayServer) {
    return getUriFromRs(relayServer, true, 2, context);
  }
  return getUriFromRs(options.server, true, 0, context);
}
