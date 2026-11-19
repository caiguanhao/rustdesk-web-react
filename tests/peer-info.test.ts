import { describe, expect, it } from 'vitest';
import { mapPeerInfo } from '../src/protocol/login';
import * as message from '../src/protocol/message';
import {
  applyDisplayList,
  clampDisplayIndex,
  type DisplayInfo,
  type PeerInfo,
} from '../src/session/peer-info';

const display = (name: string, width: number): DisplayInfo => ({
  x: 0,
  y: 0,
  width,
  height: 720,
  name,
  online: true,
});

const PEER: PeerInfo = {
  username: 'alice',
  hostname: 'desktop',
  platform: 'Linux',
  displays: [display('DP-1', 1920), display('HDMI-1', 1280)],
  currentDisplay: 1,
  sasEnabled: false,
  version: '1.5.3',
  connectionId: 42,
  privacyMode: false,
};

describe('display info', () => {
  it('clamps display indexes to the display list', () => {
    const displays = PEER.displays;
    expect(clampDisplayIndex(0, displays)).toBe(0);
    expect(clampDisplayIndex(1, displays)).toBe(1);
    expect(clampDisplayIndex(2, displays)).toBe(0);
    expect(clampDisplayIndex(-1, displays)).toBe(0);
    expect(clampDisplayIndex(1.5, displays)).toBe(0);
  });

  it('clamps an out-of-range current_display in peer_info', () => {
    const info = mapPeerInfo(
      message.PeerInfo.fromPartial({
        displays: PEER.displays,
        current_display: 9,
      }),
    );
    expect(info.currentDisplay).toBe(0);
  });

  it('merges a mid-session display list without clobbering the selection', () => {
    const updated = applyDisplayList(PEER, [
      display('DP-1', 1920),
      display('HDMI-1', 1280),
      display('USB-C', 1024),
    ]);
    expect(updated.displays).toHaveLength(3);
    expect(updated.currentDisplay).toBe(1);
    expect(updated.username).toBe('alice');

    expect(applyDisplayList(PEER, [display('DP-1', 1920)]).currentDisplay).toBe(0);
  });

  it('ignores an empty display sync', () => {
    expect(applyDisplayList(PEER, [])).toBe(PEER);
  });
});
