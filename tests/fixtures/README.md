# v1 protobuf golden fixtures

`v1-protobuf.json` contains base64-encoded messages produced by the pristine
rustdesk-web v1 codecs. `tests/protocol.test.ts` asserts that the vendored
codecs decode them and re-encode the exact same bytes, and that equivalent
freshly built v1-shaped messages encode identically.

The JSON records the source branch/commit and the SHA-256 of both original
TypeScript files. To regenerate (only needed when adding representatives),
check out the files from the pinned commit in a temporary directory, import
them from a throwaway Vitest file, and write the same structure. Do not
generate fixtures from `src/protocol/` after local additions, or the byte
comparison becomes self-referential.

Local additions in `src/protocol/message.ts` all default to protobuf zero
values, which encoders omit. If a future change makes a new field non-zero by
default, the fixture round-trip test will fail by design.
