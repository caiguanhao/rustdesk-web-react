/**
 * Resolve the hbbs server key before a connect attempt.
 *
 * Sources, in order:
 *   1. `serverKeyProvider` — per-connect fetch; a non-empty result wins.
 *   2. `serverKeyVerifier` — signed envelope (`1000::<key>` or raw key).
 *   3. static `serverKey`.
 *
 * Provider failures fail closed. A configured verifier that cannot be
 * verified also fails closed; it never falls back to the static key. The
 * verifier payload is plaintext (the signature only proves integrity), so it
 * is not a way to keep the key secret from the browser.
 */
import {
  SIGN_PUBLIC_KEY_BYTES,
  decodeBase64,
  verifySigned,
} from '../crypto/handshake.js';
import { raceAbort, throwIfAborted } from '../protocol/connection.js';
import { RustDeskError, isAbortError } from './errors.js';
import type { RustDeskSessionConfig } from './options.js';
import { isPromiseLike } from './promise.js';

const PAYLOAD_PREFIX = '1000::';
const TEXT_DECODER = new TextDecoder();

function missingKeyError(): RustDeskError {
  return new RustDeskError(
    'server-key-missing',
    'serverKeyProvider failed; refusing to connect without a server key',
  );
}

function invalidKeyError(message: string, cause?: unknown): RustDeskError {
  return new RustDeskError(
    'server-key-invalid',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function normalizeProviderResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result !== 'string') throw missingKeyError();
  const value = result.trim();
  return value.length > 0 ? value : undefined;
}

function afterProvider(
  config: Pick<RustDeskSessionConfig, 'serverKey' | 'serverKeyVerifier'>,
): string | undefined | Promise<string | undefined> {
  if (config.serverKeyVerifier) return verifierKey(config.serverKeyVerifier);
  return config.serverKey;
}

async function providerKeyAsync(
  result: Promise<unknown>,
  config: Pick<RustDeskSessionConfig, 'serverKey' | 'serverKeyVerifier'>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let value: unknown;
  try {
    value = await raceAbort(result, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw missingKeyError();
  }
  return normalizeProviderResult(value) ?? afterProvider(config);
}

/**
 * Extract the key from a verifier payload.
 * `1000::<key>` takes the whole remainder after the prefix (matching the
 * RustDesk web client verifier payload); anything else is treated as a raw key.
 */
export function extractServerKeyPayload(payload: string): string | undefined {
  const text = payload.trim();
  if (text.length === 0) return undefined;
  if (text.startsWith(PAYLOAD_PREFIX)) {
    const key = text.slice(PAYLOAD_PREFIX.length).trim();
    return key ? key : undefined;
  }
  return text;
}

async function verifierKey(
  verifier: NonNullable<RustDeskSessionConfig['serverKeyVerifier']>,
): Promise<string> {
  const publicKey = verifier.publicKey?.trim();
  const signedValue = verifier.verifier?.trim();
  if (!publicKey || !signedValue) {
    throw invalidKeyError('serverKeyVerifier is missing its publicKey or verifier');
  }

  try {
    const signed = await decodeBase64(signedValue);
    const opened = await verifySigned(signed, publicKey);
    if (!opened) {
      throw invalidKeyError('serverKeyVerifier signature did not verify');
    }
    const key = extractServerKeyPayload(TEXT_DECODER.decode(opened));
    if (!key) {
      throw invalidKeyError('serverKeyVerifier payload does not contain a key');
    }
    const decoded = await decodeBase64(key);
    if (decoded.length !== SIGN_PUBLIC_KEY_BYTES) {
      throw invalidKeyError(
        `serverKeyVerifier key must be ${SIGN_PUBLIC_KEY_BYTES} bytes`,
      );
    }
    return key;
  } catch (error) {
    if (
      error instanceof RustDeskError &&
      (error.code === 'asset-load-failed' ||
        error.code === 'aborted' ||
        error.code === 'server-key-invalid')
    ) {
      throw error;
    }
    throw invalidKeyError('serverKeyVerifier could not be decoded', error);
  }
}

/**
 * Resolve the server key for one connect attempt. Called before any socket is
 * opened; an aborted signal rejects with `aborted`.
 *
 * Returns synchronously for the static-key and sync-provider fast paths so an
 * immediate dispose keeps the established connect timing. Async providers,
 * verifiers and thrown values return a Promise.
 */
export function resolveServerKey(
  config: Pick<
    RustDeskSessionConfig,
    'serverKey' | 'serverKeyProvider' | 'serverKeyVerifier'
  >,
  signal?: AbortSignal,
): string | undefined | Promise<string | undefined> {
  throwIfAborted(signal);

  if (config.serverKeyProvider) {
    let result: unknown;
    try {
      result = config.serverKeyProvider();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw missingKeyError();
    }
    if (isPromiseLike(result)) {
      return providerKeyAsync(result, config, signal);
    }
    return normalizeProviderResult(result) ?? afterProvider(config);
  }
  return afterProvider(config);
}
