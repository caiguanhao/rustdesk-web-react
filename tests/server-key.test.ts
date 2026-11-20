import { beforeAll, describe, expect, it } from 'vitest';
import { loadSodium, type Sodium } from '../src/crypto/sodium';
import { RustDeskError, type RustDeskErrorCode } from '../src/session/errors';
import type { RustDeskServerKeyVerifier } from '../src/session/options';
import { extractServerKeyPayload, resolveServerKey } from '../src/session/server-key';

// P6 server-key coverage: provider precedence, fallthrough, fail-closed
// verifier handling, RustDesk `1000::<key>` payloads and abort behaviour.

const SERVER_KEY = Buffer.alloc(32, 0x42).toString('base64');
const PROVIDER_KEY = Buffer.alloc(32, 0x43).toString('base64');
const STATIC_KEY = Buffer.alloc(32, 0x44).toString('base64');

let sodium: Sodium;
let signerKeys: { publicKey: Uint8Array; privateKey: Uint8Array };
let otherKeys: { publicKey: Uint8Array; privateKey: Uint8Array };

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64');

const seed = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

function verifierFor(
  payload: string,
  keys: { publicKey: Uint8Array; privateKey: Uint8Array } = signerKeys,
): RustDeskServerKeyVerifier {
  const signed = sodium.crypto_sign(
    new TextEncoder().encode(payload),
    keys.privateKey,
  );
  return {
    publicKey: base64(keys.publicKey),
    verifier: base64(signed),
  };
}

async function expectCode(
  run: () => unknown,
  code: RustDeskErrorCode,
): Promise<void> {
  try {
    await run();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RustDeskError);
    expect((error as RustDeskError).code).toBe(code);
  }
}

beforeAll(async () => {
  sodium = await loadSodium();
  signerKeys = sodium.crypto_sign_seed_keypair(seed(0x33));
  otherKeys = sodium.crypto_sign_seed_keypair(seed(0x34));
});

describe('extractServerKeyPayload', () => {
  it('extracts the remainder after the 1000:: prefix', () => {
    expect(extractServerKeyPayload(`1000::${SERVER_KEY}`)).toBe(SERVER_KEY);
    expect(extractServerKeyPayload(`1000::${SERVER_KEY}\n`)).toBe(SERVER_KEY);
    expect(extractServerKeyPayload(`1000::${SERVER_KEY}:suffix`)).toBe(
      `${SERVER_KEY}:suffix`,
    );
  });

  it('treats a non-prefixed payload as a raw key', () => {
    expect(extractServerKeyPayload(SERVER_KEY)).toBe(SERVER_KEY);
    expect(extractServerKeyPayload('  ')).toBeUndefined();
    expect(extractServerKeyPayload('1000::')).toBeUndefined();
  });
});

describe('resolveServerKey provider', () => {
  it('returns a synchronous provider key and trims it', () => {
    const result = resolveServerKey({
      serverKeyProvider: () => `  ${PROVIDER_KEY}  `,
    });
    expect(result).toBe(PROVIDER_KEY);
  });

  it('resolves an asynchronous provider key', async () => {
    await expect(
      resolveServerKey({ serverKeyProvider: async () => PROVIDER_KEY }),
    ).resolves.toBe(PROVIDER_KEY);
  });

  it('falls through empty provider results to the static key', () => {
    for (const value of [undefined, null, '', '   ']) {
      const result = resolveServerKey({
        serverKey: STATIC_KEY,
        serverKeyProvider: () => value as string | undefined,
      });
      expect(result).toBe(STATIC_KEY);
    }
  });

  it('falls through an empty provider to the verifier', async () => {
    await expect(
      resolveServerKey({
        serverKey: STATIC_KEY,
        serverKeyProvider: () => '',
        serverKeyVerifier: verifierFor(`1000::${SERVER_KEY}`),
      }),
    ).resolves.toBe(SERVER_KEY);
  });

  it('fails closed when the provider throws or returns a non-string', async () => {
    await expectCode(
      () =>
        resolveServerKey({
          serverKeyProvider: () => {
            throw new Error('SECRET provider failure');
          },
        }),
      'server-key-missing',
    );
    await expectCode(
      () =>
        resolveServerKey({
          serverKeyProvider: () => 123 as unknown as string,
        }),
      'server-key-missing',
    );
  });

  it('rejects with aborted when the signal aborts during an async provider', async () => {
    const controller = new AbortController();
    const result = resolveServerKey(
      { serverKeyProvider: () => new Promise<string>(() => {}) },
      controller.signal,
    );
    controller.abort();
    await expectCode(() => result, 'aborted');
  });

  it('throws aborted for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expectCode(
      () =>
        resolveServerKey(
          { serverKeyProvider: () => PROVIDER_KEY },
          controller.signal,
        ),
      'aborted',
    );
  });
});

describe('resolveServerKey verifier', () => {
  it('accepts 1000::<key>, trailing newline and raw payloads', async () => {
    for (const payload of [
      `1000::${SERVER_KEY}`,
      `1000::${SERVER_KEY}\n`,
      SERVER_KEY,
    ]) {
      await expect(
        resolveServerKey({ serverKeyVerifier: verifierFor(payload) }),
      ).resolves.toBe(SERVER_KEY);
    }
  });

  it('rejects malformed, tampered or unverifiable envelopes', async () => {
    const good = verifierFor(`1000::${SERVER_KEY}`);
    const goodSigned = Buffer.from(good.verifier, 'base64');
    const tampered = Uint8Array.from(goodSigned);
    tampered[0] = tampered[0]! ^ 1;
    const badKey = base64(new Uint8Array(31).fill(1));

    const cases: RustDeskServerKeyVerifier[] = [
      { publicKey: 'not-base64', verifier: good.verifier },
      { publicKey: good.publicKey, verifier: 'not-base64' },
      { publicKey: '', verifier: good.verifier },
      { publicKey: good.publicKey, verifier: '' },
      {
        publicKey: base64(signerKeys.publicKey),
        verifier: base64(
          sodium.crypto_sign(
            new TextEncoder().encode(`1000::${SERVER_KEY}`),
            otherKeys.privateKey,
          ),
        ),
      },
      { publicKey: good.publicKey, verifier: base64(tampered) },
      verifierFor(`1000::${badKey}`),
      verifierFor('1000::'),
      verifierFor(`2000::${SERVER_KEY}`),
      verifierFor(`1000::${SERVER_KEY}:suffix`),
    ];

    for (const verifier of cases) {
      await expectCode(
        () => resolveServerKey({ serverKeyVerifier: verifier }),
        'server-key-invalid',
      );
    }
  });

  it('does not fall back to the static key when the verifier is invalid', async () => {
    await expectCode(
      () =>
        resolveServerKey({
          serverKey: STATIC_KEY,
          serverKeyVerifier: { publicKey: 'bad', verifier: 'bad' },
        }),
      'server-key-invalid',
    );
  });
});

describe('resolveServerKey precedence', () => {
  it('provider wins over an invalid verifier and static key', () => {
    const result = resolveServerKey({
      serverKeyProvider: () => PROVIDER_KEY,
      serverKeyVerifier: { publicKey: 'bad', verifier: 'bad' },
      serverKey: STATIC_KEY,
    });
    expect(result).toBe(PROVIDER_KEY);
  });

  it('uses static when no provider/verifier is configured', () => {
    expect(resolveServerKey({ serverKey: STATIC_KEY })).toBe(STATIC_KEY);
    expect(resolveServerKey({})).toBeUndefined();
  });
});
