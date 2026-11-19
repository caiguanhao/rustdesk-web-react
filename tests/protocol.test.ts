import { describe, expect, it } from 'vitest';
import _m0 from 'protobufjs/minimal';
import fixture from './fixtures/v1-protobuf.json';
import * as message from '../src/protocol/message';
import * as rendezvous from '../src/protocol/rendezvous';

// P1-1 acceptance. The fixture was produced once from the pristine v1 modules
// (metadata is in the JSON), so byte equality here proves the vendored codecs
// still emit exactly what rustdesk-web v1 emitted. New MVP fields default to
// the protobuf zero value and must not change those bytes.

type Codec = {
  encode(value: unknown): { finish(): Uint8Array };
  decode(bytes: Uint8Array): unknown;
};

const codecs: Record<string, Codec> = {
  'message.Clipboard': message.Clipboard,
  'message.Hash': message.Hash,
  'message.IdPk': message.IdPk,
  'message.SignedId': message.SignedId,
  'message.PublicKey': message.PublicKey,
  'message.TestDelay': message.TestDelay,
  'message.LoginRequest': message.LoginRequest,
  'message.MouseEvent': message.MouseEvent,
  'message.KeyEvent': message.KeyEvent,
  'message.Message': message.Message,
  'rendezvous.RendezvousMessage': rendezvous.RendezvousMessage,
};

const fixtureByName = new Map(fixture.entries.map((entry) => [entry.name, entry]));

const decode64 = (value: string): Uint8Array => Buffer.from(value, 'base64');
const encode64 = (value: Uint8Array): string => Buffer.from(value).toString('base64');

function expectFixtureBytes(name: string, actual: Uint8Array): void {
  const entry = fixtureByName.get(name);
  if (!entry) throw new Error(`missing fixture ${name}`);
  expect(encode64(actual)).toBe(entry.bytes);
}

/** Append a protobuf field that this schema does not know about. */
const unknownVarint = (field: number, value: number): Uint8Array =>
  _m0.Writer.create().uint32((field << 3) | 0).uint32(value).finish();

const unknownBytes = (field: number, payload: Uint8Array): Uint8Array =>
  _m0.Writer.create().uint32((field << 3) | 2).bytes(payload).finish();

// Keep decode inputs as plain Uint8Array: protobufjs returns Buffer slices
// when handed a Buffer, which would make byte assertions type-sensitive.
const concat = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts));

describe('v1 protobuf compatibility', () => {
  it('pins the pristine v1 source', () => {
    expect(fixture.source.commit).toBe('8a9af6ecdd511fa97e89844e27c5d2dae53acd77');
    expect(fixture.source.files).toEqual([
      {
        path: 'js/src/message.ts',
        sha256: '05149b0ecbbe3c574fe1a90c3eef0224b79920cee735016069561ece0436e316',
      },
      {
        path: 'js/src/rendezvous.ts',
        sha256: '5628eb12e1b5b30c1e489b08e64bbb7175ba43d1083728281ad1d07914fbbc00',
      },
    ]);
  });

  it.each(fixture.entries.map((entry) => [entry.name, entry] as const))(
    '%s decodes and re-encodes byte-identically',
    (_name, entry) => {
      const codec = codecs[entry.type];
      expect(codec).toBeDefined();
      if (!codec) return;
      const decoded = codec.decode(decode64(entry.bytes));
      expect(encode64(codec.encode(decoded).finish())).toBe(entry.bytes);
    },
  );

  it('encodes fresh v1-shaped messages to the same bytes', () => {
    const cases: [name: string, build: () => Uint8Array][] = [
      [
        'clipboard-text',
        () =>
          message.Clipboard.encode(
            message.Clipboard.fromPartial({
              compress: true,
              content: Uint8Array.from([104, 105]),
            }),
          ).finish(),
      ],
      [
        'login-request',
        () =>
          message.LoginRequest.encode(
            message.LoginRequest.fromPartial({
              username: '123456789',
              password: Uint8Array.from([1, 2, 3, 4]),
              my_id: 'web',
              my_name: 'web',
              option: message.OptionMessage.fromPartial({
                image_quality: message.ImageQuality.Balanced,
                disable_audio: message.OptionMessage_BoolOption.Yes,
                show_remote_cursor: message.OptionMessage_BoolOption.No,
              }),
              video_ack_required: true,
            }),
          ).finish(),
      ],
      [
        'key-event',
        () =>
          message.KeyEvent.encode(
            message.KeyEvent.fromPartial({
              down: true,
              press: false,
              control_key: message.ControlKey.Control,
              modifiers: [message.ControlKey.Control],
            }),
          ).finish(),
      ],
      [
        'mouse-event',
        () =>
          message.MouseEvent.encode(
            message.MouseEvent.fromPartial({
              mask: 9,
              x: 100,
              y: 200,
              modifiers: [message.ControlKey.Control, message.ControlKey.Shift],
            }),
          ).finish(),
      ],
      [
        'punch-hole-request',
        () =>
          rendezvous.RendezvousMessage.encode(
            rendezvous.RendezvousMessage.fromPartial({
              punch_hole_request: rendezvous.PunchHoleRequest.fromPartial({
                id: '123456789',
                nat_type: rendezvous.NatType.SYMMETRIC,
                licence_key: 'test-key',
                conn_type: rendezvous.ConnType.DEFAULT_CONN,
              }),
            }),
          ).finish(),
      ],
      [
        'request-relay',
        () =>
          rendezvous.RendezvousMessage.encode(
            rendezvous.RendezvousMessage.fromPartial({
              request_relay: rendezvous.RequestRelay.fromPartial({
                uuid: 'uuid-1',
                socket_addr: Uint8Array.from([9, 9, 9, 9]),
                relay_server: 'rd.example.com',
                licence_key: 'test-key',
                conn_type: rendezvous.ConnType.DEFAULT_CONN,
              }),
            }),
          ).finish(),
      ],
    ];

    for (const [name, build] of cases) {
      expectFixtureBytes(name, build());
    }
  });

  it('decodes relay/login/handshake fixture details', () => {
    const relay = rendezvous.RendezvousMessage.decode(
      decode64(fixtureByName.get('relay-response')!.bytes),
    ).relay_response;
    expect(relay?.uuid).toBe('uuid-1');
    expect(relay?.relay_server).toBe('rd.example.com');
    expect(relay?.version).toBe('1.5.3');
    expect(relay?.refuse_reason).toBe('');

    const peer = message.Message.decode(
      decode64(fixtureByName.get('message-login-response')!.bytes),
    ).login_response?.peer_info;
    expect(peer?.platform).toBe('Linux');
    expect(peer?.displays[0]).toMatchObject({ width: 1920, height: 1080 });

    expect(message.IdPk.decode(decode64(fixtureByName.get('id-pk')!.bytes))).toMatchObject({
      id: '123456789',
    });
    expect(
      Array.from(message.SignedId.decode(decode64(fixtureByName.get('signed-id')!.bytes)).id),
    ).toEqual([1, 2, 3]);
  });
});

describe('unknown fields', () => {
  it('skips unknown top-level, nested and multi-clipboard fields', () => {
    const clipboard = decode64(fixtureByName.get('clipboard-text')!.bytes);
    const withUnknowns = concat(
      clipboard,
      unknownVarint(99, 7),
      unknownBytes(100, Uint8Array.from([1, 2, 3])),
    );
    const decoded = message.Clipboard.decode(withUnknowns);
    expect(decoded.compress).toBe(true);
    expect(new TextDecoder().decode(decoded.content)).toBe('hi');
    expect(decoded.format).toBe(message.ClipboardFormat.Text);

    // Field 16 is `Message.clipboard`; the payload carries the extra unknowns.
    const envelope = message.Message.decode(unknownBytes(16, withUnknowns));
    expect(new TextDecoder().decode(envelope.clipboard?.content)).toBe('hi');

    const misc = decode64(fixtureByName.get('message-misc-video-received')!.bytes);
    expect(message.Message.decode(concat(misc, unknownVarint(100, 1))).misc?.video_received).toBe(
      true,
    );
    expect(message.Message.decode(unknownVarint(100, 1)).misc).toBeUndefined();

    const multi = message.MultiClipboards.encode(
      message.MultiClipboards.fromPartial({
        clipboards: [message.Clipboard.fromPartial({ content: Uint8Array.from([9]) })],
      }),
    ).finish();
    const decodedMulti = message.MultiClipboards.decode(concat(multi, unknownVarint(99, 5)));
    expect(Array.from(decodedMulti.clipboards[0]?.content ?? [])).toEqual([9]);
  });
});

describe('MVP field additions', () => {
  it('round-trips Clipboard.format and keeps Text as the zero value', () => {
    const text = message.Clipboard.fromPartial({ content: Uint8Array.from([104, 105]) });
    expect(text.format).toBe(message.ClipboardFormat.Text);
    expect(encode64(message.Clipboard.encode(text).finish())).toBe('EgJoaQ==');

    const html = message.Clipboard.encode(
      message.Clipboard.fromPartial({
        content: Uint8Array.from([1]),
        format: message.ClipboardFormat.Html,
      }),
    ).finish();
    // content (field 2) + format (field 5, value 2) on the wire.
    expect(encode64(html)).toBe('EgEBKAI=');
    expect(message.Clipboard.decode(html).format).toBe(message.ClipboardFormat.Html);
  });

  it('round-trips MultiClipboards inside Message field 28', () => {
    const payload = message.Message.fromPartial({
      multi_clipboards: message.MultiClipboards.fromPartial({
        clipboards: [
          message.Clipboard.fromPartial({ content: Uint8Array.from([1]) }),
          message.Clipboard.fromPartial({
            content: Uint8Array.from([2]),
            format: message.ClipboardFormat.Html,
          }),
        ],
      }),
    });
    const decoded = message.Message.decode(message.Message.encode(payload).finish()).multi_clipboards;
    expect(decoded?.clipboards).toHaveLength(2);
    expect(decoded?.clipboards[1]?.format).toBe(message.ClipboardFormat.Html);
  });

  it('round-trips optional LoginRequest version/platform', () => {
    const login = message.LoginRequest.fromPartial({
      username: '1',
      my_id: 'web',
      my_name: 'web',
      version: '1.3.7',
      my_platform: 'web',
    });
    const decoded = message.LoginRequest.decode(message.LoginRequest.encode(login).finish());
    expect(decoded.version).toBe('1.3.7');
    expect(decoded.my_platform).toBe('web');
    expect(decoded.my_id).toBe('web');
  });

  it('keeps PublicKey.kx_version 0 omitted', () => {
    const v1 = message.PublicKey.encode(
      message.PublicKey.fromPartial({
        asymmetric_value: Uint8Array.from([1]),
        symmetric_value: Uint8Array.from([2]),
        kx_version: 0,
      }),
    ).finish();
    expect(encode64(v1)).toBe('CgEBEgEC');
    expect(message.PublicKey.decode(v1).kx_version).toBe(0);
  });

  it('round-trips KeyEvent.mode and VideoFrame.display', () => {
    const key = message.KeyEvent.decode(
      message.KeyEvent.encode(
        message.KeyEvent.fromPartial({ seq: '中文', mode: message.KeyboardMode.Translate }),
      ).finish(),
    );
    expect(key.mode).toBe(message.KeyboardMode.Translate);
    expect(key.seq).toBe('中文');

    const frame = message.VideoFrame.decode(
      message.VideoFrame.encode(
        message.VideoFrame.fromPartial({
          display: 1,
          timestamp: 5,
          vp9s: message.VP9s.fromPartial({
            frames: [message.VP9.fromPartial({ data: Uint8Array.from([0]), key: true })],
          }),
        }),
      ).finish(),
    );
    expect(frame.display).toBe(1);
    expect(frame.vp9s?.frames[0]?.key).toBe(true);
  });
});
