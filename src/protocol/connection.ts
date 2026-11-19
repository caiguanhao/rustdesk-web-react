/**
 * Rendezvous → relay connection state machine.
 *
 *   1. Open hbbs and send `PunchHoleRequest{id, licence_key, nat_type:
 *      SYMMETRIC, conn_type: DEFAULT_CONN}`. `SYMMETRIC` is what makes the
 *      peer advertise `relay_v4` and create an hbbr leg; browsers cannot
 *      punch holes, so `force_relay` alone is not enough.
 *   2. Wait for `RelayResponse`, rejecting `refuse_reason`, a missing remote
 *      version, ID-not-found/offline/licence failures, and a successful
 *      `PunchHoleResponse` (which offers no relay for a browser).
 *   3. Close hbbs, open hbbr (response `relay_server` wins, then config,
 *      then hbbs port+3), and send `RequestRelay{uuid, licence_key}`.
 *   4. Run `secureHandshake` on the relay leg. hbbr parks the first leg for
 *      up to 30 s waiting for the peer; that wait surfaces as the secure
 *      handshake's SignedId read, matching RustDesk's 18 s read budget.
 *
 * `nextRelayMessage` maps the peer's `Misc.close_reason` to `peer-closed`
 * for the login/session loop (P1-7). All waits honour an optional
 * `AbortSignal`; aborting closes any open sockets.
 */
import * as message from './message.js';
import type { DeepPartial as MessagePartial } from './message.js';
import * as rendezvous from './rendezvous.js';
import { secureHandshake } from './secure.js';
import { resolveRelayUrl, resolveRendezvousUrl, type UrlContext } from './url.js';
import { WebSock, type WebSocketFactory } from './websock.js';
import { loadSodium } from '../crypto/sodium.js';
import { RustDeskError } from '../session/errors.js';

export const DEFAULT_RENDEZVOUS_RESPONSE_TIMEOUT_MS = 12_000;

export interface RendezvousConnectOptions extends UrlContext {
  /** hbbs host (`host` or `host:port`). */
  server: string;
  /** Requested device id sent in PunchHoleRequest. */
  peerId: string;
  /** hbbs public key; also sent as `licence_key` for self-hosted servers. */
  serverKey?: string;
  /** Optional relay host override when RelayResponse has none. */
  relayServer?: string;
  /** Explicit ws(s):// endpoints (tests/non-standard proxies). */
  rendezvousUrl?: string;
  relayUrl?: string;
  /** v1 plaintext fallback when the peer identity cannot be verified. */
  allowInsecureFallback?: boolean;
  /** WebSocket open timeout for both hbbs and hbbr (WebSock default 12 s). */
  openTimeoutMs?: number;
  /** Wait for the RelayResponse (default 12 s). */
  responseTimeoutMs?: number;
  /** Secure handshake budget (default 18 s). */
  securingTimeoutMs?: number;
  /** Cancels the connect attempt and closes any open sockets. */
  signal?: AbortSignal;
  /** Test/Node injection for both sockets. */
  createSocket?: WebSocketFactory;
}

export interface RelayConnection {
  relayResponse: rendezvous.RelayResponse;
  rendezvousUrl: string;
  relayUrl: string;
  /** False only when `allowInsecureFallback` downgraded the session. */
  secure: boolean;
  /** Present when `secure === false`. */
  downgrade?: RustDeskError;
  /** Encrypt (when secured) and send one Message frame. */
  sendMessage(payload: MessagePartial<message.Message>): void;
  /** Next peer message; throws `peer-closed` for `Misc.close_reason`. */
  nextMessage(timeoutMs?: number, signal?: AbortSignal): Promise<message.Message>;
  close(): void;
}

function abortError(): RustDeskError {
  return new RustDeskError('aborted', 'Connection attempt aborted');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort?.();
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function punchHoleFailure(response: rendezvous.PunchHoleResponse): RustDeskError {
  if (response.other_failure) {
    return new RustDeskError('rendezvous-refused', response.other_failure);
  }
  switch (response.failure) {
    case rendezvous.PunchHoleResponse_Failure.ID_NOT_EXIST:
      return new RustDeskError(
        'id-not-found',
        'The requested device ID is not registered with hbbs',
      );
    case rendezvous.PunchHoleResponse_Failure.OFFLINE:
      return new RustDeskError('peer-offline', 'The requested device is offline');
    case rendezvous.PunchHoleResponse_Failure.LICENSE_MISMATCH:
      return new RustDeskError(
        'server-key-invalid',
        'The rendezvous server rejected the configured serverKey (licence mismatch)',
      );
    case rendezvous.PunchHoleResponse_Failure.LICENSE_OVERUSE:
      return new RustDeskError(
        'rendezvous-refused',
        'The rendezvous server reports the server key is overused (licence overuse)',
      );
    default:
      return new RustDeskError(
        'rendezvous-refused',
        'The rendezvous server did not provide a relay connection',
      );
  }
}

async function waitForRelayResponse(
  sock: WebSock,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<rendezvous.RelayResponse> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    throwIfAborted(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new RustDeskError('timeout', `No rendezvous response within ${timeoutMs} ms`);
    }

    const msg = await raceAbort(sock.nextRendezvous(remaining), signal, () => sock.close());
    const relay = msg.relay_response;
    if (relay) {
      if (relay.refuse_reason) {
        throw new RustDeskError('rendezvous-refused', `Relay refused: ${relay.refuse_reason}`);
      }
      if (!relay.version) {
        throw new RustDeskError(
          'unsupported-version',
          'The remote RustDesk version does not support web clients',
        );
      }
      if (!relay.uuid) {
        throw new RustDeskError('protocol-error', 'RelayResponse is missing the relay uuid');
      }
      return relay;
    }
    if (msg.punch_hole_response) throw punchHoleFailure(msg.punch_hole_response);
    // Ignore unrelated rendezvous messages until the deadline.
  }
}

/**
 * Establish hbbs → hbbr → secure connection. On failure all opened sockets
 * are closed; on success only the relay socket stays open.
 */
export async function connectRelay(
  options: RendezvousConnectOptions,
): Promise<RelayConnection> {
  throwIfAborted(options.signal);
  // Overlap libsodium's download/init with the hbbs round trip. Failures are
  // retried by secureHandshake, which reports asset-load-failed.
  void loadSodium().catch(() => {});

  const rendezvousUrl = resolveRendezvousUrl({
    server: options.server,
    rendezvousUrl: options.rendezvousUrl,
    secure: options.secure,
  });
  const responseTimeoutMs =
    options.responseTimeoutMs ?? DEFAULT_RENDEZVOUS_RESPONSE_TIMEOUT_MS;

  let rendezvousSock: WebSock | undefined;
  let relaySock: WebSock | undefined;
  let keepRelay = false;

  try {
    rendezvousSock = new WebSock(rendezvousUrl, { createSocket: options.createSocket });
    await raceAbort(rendezvousSock.open(options.openTimeoutMs), options.signal);

    rendezvousSock.sendRendezvous({
      punch_hole_request: {
        id: options.peerId,
        licence_key: options.serverKey ?? '',
        nat_type: rendezvous.NatType.SYMMETRIC,
        conn_type: rendezvous.ConnType.DEFAULT_CONN,
      },
    });

    const relayResponse = await waitForRelayResponse(
      rendezvousSock,
      responseTimeoutMs,
      options.signal,
    );
    rendezvousSock.close();

    let relayUrl: string;
    try {
      relayUrl = resolveRelayUrl({
        server: options.server,
        relayServer: relayResponse.relay_server || options.relayServer,
        relayUrl: options.relayUrl,
        secure: options.secure,
      });
    } catch (error) {
      // A malformed host supplied by hbbs is a protocol failure, not a
      // host-app configuration error.
      if (
        relayResponse.relay_server &&
        !options.relayUrl &&
        error instanceof RustDeskError &&
        error.code === 'invalid-config'
      ) {
        throw new RustDeskError(
          'rendezvous-refused',
          'The rendezvous server supplied an invalid relay address',
          { cause: error },
        );
      }
      throw error;
    }

    throwIfAborted(options.signal);
    relaySock = new WebSock(relayUrl, { createSocket: options.createSocket });
    await raceAbort(relaySock.open(options.openTimeoutMs), options.signal);

    relaySock.sendRendezvous({
      request_relay: {
        uuid: relayResponse.uuid,
        licence_key: options.serverKey ?? '',
      },
    });

    const secureResult = await raceAbort(
      secureHandshake(relaySock, {
        peerId: options.peerId,
        serverKey: options.serverKey,
        signedIdPk: relayResponse.pk,
        allowInsecureFallback: options.allowInsecureFallback,
        timeoutMs: options.securingTimeoutMs,
      }),
      options.signal,
    );

    keepRelay = true;
    const relay = relaySock;
    return {
      relayResponse,
      rendezvousUrl,
      relayUrl,
      secure: secureResult.secure,
      downgrade: secureResult.secure ? undefined : secureResult.error,
      sendMessage: (payload) => relay.sendMessage(payload),
      nextMessage: (timeoutMs, signal) => nextRelayMessage(relay, timeoutMs, signal),
      close: () => relay.close(),
    };
  } finally {
    rendezvousSock?.close();
    if (!keepRelay) relaySock?.close();
  }
}

/**
 * Next peer message on an established relay leg. Throws `peer-closed` when
 * the peer sends `Misc.close_reason` (v1 ignored it). Aborting closes `sock`.
 */
async function nextRelayMessage(
  sock: WebSock,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<message.Message> {
  throwIfAborted(signal);
  const msg = await raceAbort(sock.nextMessage(timeoutMs), signal, () => sock.close());
  const reason = msg.misc?.close_reason;
  if (reason) throw new RustDeskError('peer-closed', reason);
  return msg;
}
