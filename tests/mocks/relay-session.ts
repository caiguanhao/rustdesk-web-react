import { WebSocket as WsClient } from 'ws';
import { connectRelay, type RelayConnection } from '../../src/protocol/connection';
import { LoginFlow } from '../../src/protocol/login';
import type { PeerInfo } from '../../src/session/peer-info';
import type { WebSocketLike } from '../../src/protocol/websock';
import type { MockRustDeskServer } from './rustdesk-mock';

const createSocket = (url: string): WebSocketLike =>
  new WsClient(url) as unknown as WebSocketLike;

export interface MockRelaySession {
  connection: RelayConnection;
  flow: LoginFlow;
  peerInfo: PeerInfo;
  close(): void;
}

/** Connect + login against the in-process mock hbbs/hbbr/peer. */
export async function connectMockRelay(
  mock: MockRustDeskServer,
): Promise<MockRelaySession> {
  const connection = await connectRelay({
    server: mock.server,
    secure: false,
    peerId: mock.peerId,
    serverKey: mock.serverKey,
    openTimeoutMs: 1000,
    responseTimeoutMs: 1000,
    securingTimeoutMs: 2000,
    createSocket,
  });
  const flow = new LoginFlow(connection, {
    peerId: mock.peerId,
    password: mock.password,
    loginTimeoutMs: 2000,
  });
  try {
    const peerInfo = await flow.start();
    return {
      connection,
      flow,
      peerInfo,
      close: () => {
        flow.dispose();
        connection.close();
      },
    };
  } catch (error) {
    flow.dispose();
    connection.close();
    throw error;
  }
}
