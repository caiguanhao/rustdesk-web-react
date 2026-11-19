# Input keymap provenance

`keymaps.ts` transcribes the DOM `KeyboardEvent.code` → RustDesk key name
table and the per-platform position-keycode tables from the RustDesk web
client v2. The Map-mode wire semantics and special-action shapes were checked
against RustDesk 1.5.3 (`src/keyboard.rs`, `src/server/input_service.rs`).

- Source: `rustdesk/rustdesk-web`, branch `rustdesk-web-v2`,
  commit `10a477b67f7411da21fe88f4809eab7cb81e6102`
  (`https://github.com/rustdesk/rustdesk-web`), bundle
  `js/dist/index.js`: `Lo` (DOM code → name), `_e` (Windows scancodes),
  `No` (Linux X11 keycodes), `Oo` (Android keycodes), `Uo` (macOS virtual
  keycodes), `Wo`/`Vo` (printable/numpad sets) and the CapsLock/NumLock
  snapshot logic.
- License: GNU AGPL-3.0. The AGPLv3 text is in the repository-root `LICENSE`;
  the RustDesk core project ships its `LICENCE` (AGPLv3). The rustdesk-web
  snapshot contains no license file, and no explicit "or later" grant was
  found in it; do not assume one for these keymap tables without confirming
  upstream. The rest of this project's original code is offered under
  AGPL-3.0-or-later.
- Local modifications: tables converted to TypeScript and limited to the
  entries used by Map mode; Keys are looked up by `event.code`; macOS ISO
  Backquote/IntlBackslash swap and the optional Ctrl/Meta swap are preserved.
  Android `Backquote` is kept at the published value (75) with a comment
  noting it may be an upstream bug (`KEYCODE_GRAVE` is 68); a real Android peer
  is needed to verify Map mode (P5-2).
- No Flutter, Dart, CanvasKit, or FFmpeg code is reused.
