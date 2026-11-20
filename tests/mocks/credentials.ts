import { hashPassword } from '../../src/crypto/password';

/** Base64 of the RustDesk h1 for a plaintext password and peer salt. */
export const h1Base64 = (password: string, salt: string): string =>
  Buffer.from(hashPassword(password, salt)).toString('base64');
