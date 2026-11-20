import { describe, expect, it } from 'vitest';
import {
  PASSWORD_HASH_BYTES,
  decodePasswordHash,
  normalizePasswordCredential,
  resolveConfiguredPassword,
} from '../src/session/credentials';
import { RustDeskError } from '../src/session/errors';

// P6 credential coverage: base64 h1 parsing, plaintext/hash disambiguation,
// salt preservation and the password/passwordHash conflict rule.

const H1_BASE64 = 'aQNI1fI700gr19YEVZ0wuC2GsbJL5iG4ghFlrTaUNmE=';
const H1_HEX = '690348d5f23bd3482bd7d604559d30b82d86b1b24be621b8821165ad36943661';

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64');

function expectInvalidConfig(run: () => unknown, input?: string): void {
  try {
    run();
    expect.unreachable('expected invalid-config');
  } catch (error) {
    expect(error).toBeInstanceOf(RustDeskError);
    expect((error as RustDeskError).code).toBe('invalid-config');
    if (input !== undefined) {
      expect((error as Error).message).not.toContain(input);
    }
  }
}

describe('decodePasswordHash', () => {
  it('decodes the fixed 32-byte h1 vector', () => {
    const bytes = decodePasswordHash(H1_BASE64);
    expect(bytes).toHaveLength(PASSWORD_HASH_BYTES);
    expect(toHex(bytes)).toBe(H1_HEX);
  });

  it('accepts unpadded standard base64', () => {
    expect(toHex(decodePasswordHash(H1_BASE64.replace(/=+$/, '')))).toBe(
      H1_HEX,
    );
  });

  it('rejects whitespace, base64url, empty and oversized input', () => {
    const urlSafe = base64(new Uint8Array(32).fill(0xff))
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    for (const value of ['', ' ', ` ${H1_BASE64}`, urlSafe, 'A'.repeat(65)]) {
      expectInvalidConfig(() => decodePasswordHash(value));
    }
    expectInvalidConfig(
      () => decodePasswordHash('SECRET-not-base64!'),
      'SECRET-not-base64!',
    );
  });

  it('rejects decoded lengths other than 32 bytes', () => {
    for (const length of [16, 31, 33]) {
      const value = base64(new Uint8Array(length).fill(1));
      expectInvalidConfig(() => decodePasswordHash(value), value);
    }
  });

  it('rejects non-string runtime values without echoing them', () => {
    expectInvalidConfig(() => decodePasswordHash(null as unknown as string));
    expectInvalidConfig(() => decodePasswordHash(123 as unknown as string));
  });
});

describe('normalizePasswordCredential', () => {
  it('treats strings as plaintext and preserves empty/undefined as absent', () => {
    expect(normalizePasswordCredential('secret')).toEqual({
      kind: 'plaintext',
      password: 'secret',
    });
    expect(normalizePasswordCredential('')).toBeUndefined();
    expect(normalizePasswordCredential(undefined)).toBeUndefined();
    expect(normalizePasswordCredential(null)).toBeUndefined();
  });

  it('normalizes object hashes and preserves salt including empty string', () => {
    expect(
      normalizePasswordCredential({ hash: H1_BASE64, salt: 'salt' }),
    ).toEqual({
      kind: 'hash',
      h1: decodePasswordHash(H1_BASE64),
      salt: 'salt',
    });
    expect(normalizePasswordCredential({ hash: H1_BASE64, salt: '' })).toEqual({
      kind: 'hash',
      h1: decodePasswordHash(H1_BASE64),
      salt: '',
    });
    const withoutSalt = normalizePasswordCredential({ hash: H1_BASE64 });
    expect(withoutSalt?.kind).toBe('hash');
    expect(withoutSalt).not.toHaveProperty('salt');
  });

  it('rejects malformed hashes and non-string salt', () => {
    expectInvalidConfig(() =>
      normalizePasswordCredential({ hash: 'not-base64' }),
    );
    expectInvalidConfig(() =>
      normalizePasswordCredential({
        hash: H1_BASE64,
        salt: 123 as unknown as string,
      }),
    );
    expectInvalidConfig(() =>
      normalizePasswordCredential(123 as unknown as never),
    );
  });
});

describe('resolveConfiguredPassword', () => {
  it('returns undefined when neither credential is configured', () => {
    expect(resolveConfiguredPassword({})).toBeUndefined();
    expect(resolveConfiguredPassword({ password: '' })).toBeUndefined();
  });

  it('returns plaintext when only password is configured', () => {
    expect(resolveConfiguredPassword({ password: 'secret' })).toEqual({
      kind: 'plaintext',
      password: 'secret',
    });
  });

  it('treats a bare passwordHash string as a hash, never plaintext', () => {
    expect(resolveConfiguredPassword({ passwordHash: H1_BASE64 })).toEqual({
      kind: 'hash',
      h1: decodePasswordHash(H1_BASE64),
    });
  });

  it('preserves an object hash and its salt', () => {
    expect(
      resolveConfiguredPassword({
        passwordHash: { hash: H1_BASE64, salt: 'salt' },
      }),
    ).toEqual({
      kind: 'hash',
      h1: decodePasswordHash(H1_BASE64),
      salt: 'salt',
    });
  });

  it('allows an empty password alongside passwordHash', () => {
    expect(
      resolveConfiguredPassword({ password: '', passwordHash: H1_BASE64 }),
    ).toEqual({ kind: 'hash', h1: decodePasswordHash(H1_BASE64) });
  });

  it('rejects password and passwordHash together', () => {
    expectInvalidConfig(() =>
      resolveConfiguredPassword({
        password: 'secret',
        passwordHash: H1_BASE64,
      }),
    );
  });

  it('rejects malformed passwordHash values', () => {
    expectInvalidConfig(() =>
      resolveConfiguredPassword({ passwordHash: 'not-base64' }),
    );
    expectInvalidConfig(() =>
      resolveConfiguredPassword({
        passwordHash: { hash: 'not-base64' },
      }),
    );
    expectInvalidConfig(() =>
      resolveConfiguredPassword({
        passwordHash: { hash: H1_BASE64, salt: 1 as unknown as string },
      }),
    );
  });
});

