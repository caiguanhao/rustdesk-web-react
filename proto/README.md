# RustDesk 1.5.3 protobuf references

These `.proto` files are copied verbatim from RustDesk
`1.5.3-37-gd40e1da71` (commit `d40e1da715fa1694ff4712f394b81a6df6bcd612`)
for field reference only:

- `message.proto` — `libs/base/protos/message.proto`
- `rendezvous.proto` — `libs/hbb_common/protos/rendezvous.proto`

Runtime code uses the ts-proto modules in `src/protocol/` (vendored from the
web client v1); nothing imports these files. They are AGPL-3.0-or-later, see
the repository-root `LICENSE`.

## Legacy v1 name mapping

The vendored codecs predate 1.5.3 and use different TypeScript names for the
same wire fields. P2-2/P2-4 should build on the vendored names:

| v1 module (`src/protocol/message.ts`) | 1.5.3 proto |
| --- | --- |
| `VideoFrame.vp9s: VP9s` | `VideoFrame.vp9s: EncodedVideoFrames` |
| `VP9s.frames: VP9[]` | `EncodedVideoFrames.frames: EncodedVideoFrame[]` |
| `VP9.data/key/pts` | `EncodedVideoFrame.data/key/pts` |
| `VideoFrame.timestamp` (field 9) | no longer present |
| `Message.multi_clipboards` | `Message.multi_clipboards` (added in P1-1) |
