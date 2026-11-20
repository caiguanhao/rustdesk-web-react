import { describe, expect, it } from 'vitest';
import { RustDeskError, type RustDeskErrorCode } from '../src/session/errors';
import { loadSodium } from '../src/crypto/sodium';
import {
  counterNonce,
  createSecretBoxCipher,
  decodeBase64,
  generateBoxKeyPair,
  generateSecretKey,
  openSecret,
  sealSecret,
  verifySigned,
} from '../src/crypto/handshake';
import {
  challengeResponse,
  challengeResponseFromHash,
  hashPassword,
} from '../src/crypto/password';

// P1-4 fixed vectors. Computed once with the exact v1 libsodium-wrappers
// calls (`verify`/`seal`/`makeOnce`/`encrypt`) and v1's fast-sha256 hash
// helper, so matching bytes here means matching RustDesk's wire behaviour.

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const fromHex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'));

const PASSWORD = 'correct horse battery staple';
const SALT = 'rustdesk-salt';
const CHALLENGE = '123456';

const ED25519 = {
  seed: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  publicKey: '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8',
  message: '727573746465736b2d6964706b', // "rustdesk-idpk"
  signed:
    'eb1004035fdb4234becc04a4a996b6c97f2c896df96e012f713b6ef3210f2df699eb89714f0b5d2cdb34e2bd1db9272a9adcc647b38f1fbbee3892a5d9f41a0f727573746465736b2d6964706b',
  otherPublicKey: 'bafc71bead3ac5e4b63e9c8216ee71a34aaec65722eedbca728b4e9b3ccce396',
};

const BOX = {
  aliceSk: '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
  alicePk: '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
  bobSk: '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb',
  bobPk: 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
  secret: '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
  cipher:
    '0568d85e672031a45ef6622a8619933b469160242c865883617561ad958e7711f47fa341816ebda7561ace2495bd7b62',
};

const SECRETBOX = {
  key: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  plaintext: '68656c6c6f20727573746465736b', // "hello rustdesk"
  vectors: [
    {
      seq: 1,
      nonce: '010000000000000000000000000000000000000000000000',
      cipher: '289e99d589999453a1572d64fc24875baa5ee64c9d3f8abb810c0424330f',
    },
    {
      seq: 2,
      nonce: '020000000000000000000000000000000000000000000000',
      cipher: '2190d239eebb91453c05ad0ba04b80b6437bae232504ef5289a7d1fbff27',
    },
    {
      seq: 256,
      nonce: '000100000000000000000000000000000000000000000000',
      cipher: '598604218dbf7eec94b26f882341ee1d98b30f987360061db8b249c867a4',
    },
    {
      seq: 65536,
      nonce: '000001000000000000000000000000000000000000000000',
      cipher: '4474de47cceeb77e050fb7c41b76fca4bfc521469e98cc5f36475dcb2e0e',
    },
    {
      seq: 0x0102030405,
      nonce: '050403020100000000000000000000000000000000000000',
      cipher: '5d57a8451b771d20cfe9594aec33198cae361765bacce79ab1f0e96c82f6',
    },
  ],
};

function expectCodeSync(run: () => unknown, code: RustDeskErrorCode): void {
  try {
    run();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RustDeskError);
    expect((error as RustDeskError).code).toBe(code);
  }
}

describe('password hashing', () => {
  it('matches the RustDesk salted double SHA-256', () => {
    expect(toHex(hashPassword(PASSWORD, SALT))).toBe(
      '690348d5f23bd3482bd7d604559d30b82d86b1b24be621b8821165ad36943661',
    );
    expect(toHex(challengeResponse(PASSWORD, SALT, CHALLENGE))).toBe(
      '2a668d554d6d4d240e8004839582ea6e84501b7e5987b69b5238adf48e3e3256',
    );
  });

  it('matches the plaintext wire value when built from a pre-hashed h1', () => {
    const h1 = hashPassword(PASSWORD, SALT);
    expect(toHex(challengeResponseFromHash(h1, CHALLENGE))).toBe(
      '2a668d554d6d4d240e8004839582ea6e84501b7e5987b69b5238adf48e3e3256',
    );
    expect(toHex(challengeResponseFromHash(h1, CHALLENGE))).toBe(
      toHex(challengeResponse(PASSWORD, SALT, CHALLENGE)),
    );
  });

  it('changes with password, salt and challenge', () => {
    const base = toHex(challengeResponse(PASSWORD, SALT, CHALLENGE));
    expect(toHex(challengeResponse(`${PASSWORD}!`, SALT, CHALLENGE))).not.toBe(base);
    expect(toHex(challengeResponse(PASSWORD, `${SALT}!`, CHALLENGE))).not.toBe(base);
    expect(toHex(challengeResponse(PASSWORD, SALT, `${CHALLENGE}!`))).not.toBe(base);
  });
});

describe('Ed25519 verify', () => {
  it('opens a signed message with the matching public key', async () => {
    const opened = await verifySigned(fromHex(ED25519.signed), fromHex(ED25519.publicKey));
    expect(opened && toHex(opened)).toBe(ED25519.message);
  });

  it('accepts a base64 server key and rejects a wrong signer', async () => {
    const base64 = Buffer.from(fromHex(ED25519.publicKey)).toString('base64');
    expect(await verifySigned(fromHex(ED25519.signed), base64)).not.toBeNull();
    expect(await verifySigned(fromHex(ED25519.signed), fromHex(ED25519.otherPublicKey))).toBeNull();
  });

  it('rejects malformed signatures and wrong key lengths', async () => {
    expect(await verifySigned(fromHex('deadbeef'), fromHex(ED25519.publicKey))).toBeNull();
    await expect(verifySigned(fromHex(ED25519.signed), new Uint8Array(31))).rejects.toMatchObject({
      code: 'protocol-error',
    });
  });

  it('decodes original-alphabet base64 and rejects garbage', async () => {
    expect(Array.from(await decodeBase64('AAECAw=='))).toEqual([0, 1, 2, 3]);
    await expect(decodeBase64('not base64!!!')).rejects.toMatchObject({
      code: 'invalid-config',
    });
  });

  it('lazy-initializes libsodium once', async () => {
    await expect(loadSodium()).resolves.toBe(await loadSodium());
  });
});

describe('X25519 box', () => {
  it('seals with a zero nonce and opens with the peer key', async () => {
    const cipher = await sealSecret(
      fromHex(BOX.secret),
      fromHex(BOX.bobPk),
      fromHex(BOX.aliceSk),
    );
    expect(toHex(cipher)).toBe(BOX.cipher);

    const opened = await openSecret(cipher, fromHex(BOX.alicePk), fromHex(BOX.bobSk));
    expect(opened && toHex(opened)).toBe(BOX.secret);
  });

  it('returns null for a wrong box key', async () => {
    const cipher = fromHex(BOX.cipher);
    const wrong = new Uint8Array(32).fill(0x99);
    expect(await openSecret(cipher, fromHex(BOX.bobPk), wrong)).toBeNull();
  });

  it('generates 32-byte keys and round-trips a random keypair', async () => {
    const first = await generateBoxKeyPair();
    const second = await generateBoxKeyPair();
    expect(first.publicKey).toHaveLength(32);
    expect(first.secretKey).toHaveLength(32);
    expect(first.publicKey).not.toEqual(second.publicKey);

    const key = await generateSecretKey();
    expect(key).toHaveLength(32);
    const sealed = await sealSecret(key, second.publicKey, first.secretKey);
    const opened = await openSecret(sealed, first.publicKey, second.secretKey);
    expect(opened).toEqual(key);
  });
});

describe('secretbox counter nonce', () => {
  it('writes the counter little-endian into 24 bytes', () => {
    expect(toHex(counterNonce(0))).toBe('0'.repeat(48));
    for (const vector of SECRETBOX.vectors) {
      expect(toHex(counterNonce(vector.seq))).toBe(vector.nonce);
    }
  });

  it('rejects invalid counters', () => {
    for (const value of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expectCodeSync(() => counterNonce(value), 'protocol-error');
    }
  });
});

describe('secretbox counter cipher', () => {
  it('starts at nonce 1 and matches the fixed ciphertexts', async () => {
    const cipher = await createSecretBoxCipher(fromHex(SECRETBOX.key));
    const plaintext = fromHex(SECRETBOX.plaintext);

    const first = cipher.encrypt(plaintext);
    expect(toHex(first)).toBe(SECRETBOX.vectors[0]?.cipher);
    expect(cipher.decrypt(fromHex(SECRETBOX.vectors[0]!.cipher))).toEqual(plaintext);

    const second = cipher.encrypt(plaintext);
    expect(toHex(second)).toBe(SECRETBOX.vectors[1]?.cipher);
    expect(cipher.decrypt(fromHex(SECRETBOX.vectors[1]!.cipher))).toEqual(plaintext);
  });

  it('advances to the 256th nonce', async () => {
    const cipher = await createSecretBoxCipher(fromHex(SECRETBOX.key));
    const plaintext = fromHex(SECRETBOX.plaintext);
    let last: Uint8Array = new Uint8Array();
    for (let index = 1; index <= 256; index += 1) last = cipher.encrypt(plaintext);
    expect(toHex(last)).toBe(SECRETBOX.vectors[2]?.cipher);
  });

  it('fails closed on tampering and becomes unusable until reconnect', async () => {
    const cipher = await createSecretBoxCipher(fromHex(SECRETBOX.key));
    const tampered = fromHex(SECRETBOX.vectors[0]!.cipher);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expectCodeSync(() => cipher.decrypt(tampered), 'protocol-error');

    // A MAC failure cannot resync counters, so even a valid frame is refused.
    expectCodeSync(
      () => cipher.decrypt(fromHex(SECRETBOX.vectors[0]!.cipher)),
      'protocol-error',
    );
    expectCodeSync(() => cipher.encrypt(fromHex(SECRETBOX.plaintext)), 'protocol-error');

    const wrong = await createSecretBoxCipher(new Uint8Array(32).fill(0xee));
    expectCodeSync(() => wrong.decrypt(fromHex(SECRETBOX.vectors[0]!.cipher)), 'protocol-error');
    await expect(createSecretBoxCipher(new Uint8Array(31))).rejects.toMatchObject({
      code: 'protocol-error',
    });
  });
});
