import { describe, expect, it } from 'vitest';
import { RustDeskError } from '../src/session/errors';
import {
  DEFAULT_ID_SERVER_PORT,
  getUriFromRs,
  resolveRelayUrl,
  resolveRendezvousUrl,
} from '../src/protocol/url';

// P1-2 acceptance: parity with the official v2 helper, plus the explicit
// ws(s):// overrides used for tests and non-standard reverse proxies.

/** Verbatim port of rustdesk-web-v2 `getUriFromRs` (index.js:11090). */
function officialGetUriFromRs(
  uri: string,
  isRelay = false,
  roffset = 0,
  https = false,
): string {
  const scheme = https ? 'wss://' : 'ws://';
  const [domain, uriport] = uri.split(':');
  if (https && !uriport) {
    return `${scheme}${domain}/ws/${isRelay ? 'relay' : 'id'}`;
  }
  if (uriport) {
    const port = parseInt(uriport, 10);
    uri = `${domain}:${port + (isRelay ? roffset || 3 : 2)}`;
  } else {
    uri += `:${21116 + (isRelay ? 3 : 2)}`;
  }
  return scheme + uri;
}

describe('getUriFromRs parity with official v2', () => {
  const servers = [
    'rd.example.com',
    'rd.example.com:21116',
    'rd.example.com:443',
    '10.0.0.1:21116',
  ];

  for (const server of servers) {
    for (const secure of [false, true]) {
      for (const isRelay of [false, true]) {
        for (const roffset of [0, 2, 3]) {
          it(`${server} secure=${secure} relay=${isRelay} roffset=${roffset}`, () => {
            expect(getUriFromRs(server, isRelay, roffset, { secure })).toBe(
              officialGetUriFromRs(server, isRelay, roffset, secure),
            );
          });
        }
      }
    }
  }

  it('defaults the hbbs port to 21116', () => {
    expect(DEFAULT_ID_SERVER_PORT).toBe(21116);
    expect(getUriFromRs('rd.example.com', false, 0, { secure: false })).toBe(
      'ws://rd.example.com:21118',
    );
    expect(getUriFromRs('rd.example.com', true, 0, { secure: false })).toBe(
      'ws://rd.example.com:21119',
    );
    expect(getUriFromRs('rd.example.com', false, 0, { secure: true })).toBe(
      'wss://rd.example.com/ws/id',
    );
  });

  it('supports bracketed and bare IPv6 hosts', () => {
    expect(getUriFromRs('[::1]:21116', false, 0, { secure: true })).toBe('wss://[::1]:21118');
    expect(getUriFromRs('::1', false, 0, { secure: false })).toBe('ws://[::1]:21118');
    expect(getUriFromRs('[2001:db8::1]', true, 0, { secure: true })).toBe(
      'wss://[2001:db8::1]/ws/relay',
    );
  });
});

function expectInvalid(run: () => unknown): void {
  try {
    run();
    expect.unreachable('expected an invalid-config error');
  } catch (error) {
    expect(error).toBeInstanceOf(RustDeskError);
    expect((error as RustDeskError).code).toBe('invalid-config');
  }
}

describe('explicit URL overrides', () => {
  it('returns rendezvousUrl unchanged and ignores server', () => {
    const url = 'wss://proxy.example.com/custom/ws/id?x=1';
    expect(
      resolveRendezvousUrl({ server: 'ignored.example.com', rendezvousUrl: url, secure: true }),
    ).toBe(url);
  });

  it('returns relayUrl unchanged and takes priority', () => {
    const url = 'ws://127.0.0.1:9999/ws/relay';
    expect(
      resolveRelayUrl({
        server: 'rd.example.com',
        relayServer: 'relay.example.com:21117',
        relayUrl: url,
        secure: false,
      }),
    ).toBe(url);
  });

  it('rejects non-ws protocols and mixed content', () => {
    expectInvalid(() =>
      resolveRendezvousUrl({ server: 'rd.example.com', rendezvousUrl: 'https://x/ws/id' }),
    );
    expectInvalid(() =>
      resolveRendezvousUrl({
        server: 'rd.example.com',
        rendezvousUrl: 'ws://x/ws/id',
        secure: true,
      }),
    );
    expectInvalid(() =>
      resolveRendezvousUrl({ server: 'rd.example.com', rendezvousUrl: 'not a url' }),
    );
    expect(() =>
      resolveRendezvousUrl({
        server: 'rd.example.com',
        rendezvousUrl: 'wss://x/ws/id',
        secure: false,
      }),
    ).not.toThrow();
  });
});

describe('relay URL sources', () => {
  it('uses hbbr +2 for relayServer (RelayResponse) and +3 for fallback', () => {
    expect(
      resolveRelayUrl({ server: 'rd.example.com:21116', relayServer: 'relay.example.com:21117', secure: true }),
    ).toBe('wss://relay.example.com:21119');

    expect(
      resolveRelayUrl({ server: 'rd.example.com:21116', secure: true }),
    ).toBe('wss://rd.example.com:21119');

    expect(
      resolveRelayUrl({ server: 'rd.example.com', relayServer: 'relay.example.com', secure: true }),
    ).toBe('wss://relay.example.com/ws/relay');

    expect(resolveRelayUrl({ server: 'rd.example.com', secure: true })).toBe(
      'wss://rd.example.com/ws/relay',
    );

    expect(
      resolveRelayUrl({ server: 'rd.example.com:21116', relayServer: 'relay.example.com:21117', secure: false }),
    ).toBe('ws://relay.example.com:21119');
    expect(resolveRelayUrl({ server: 'rd.example.com', secure: false })).toBe(
      'ws://rd.example.com:21119',
    );
  });
});

describe('invalid servers', () => {
  it.each(['', '   ', 'host:abc', 'host:0', 'host:70000', 'http://host', 'host/path'])(
    'rejects %j with invalid-config',
    (server) => {
      expectInvalid(() => getUriFromRs(server, false, 0, { secure: true }));
    },
  );
});
