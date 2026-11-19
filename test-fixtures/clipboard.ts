/**
 * P3-5 zstd clipboard vectors.
 *
 * Generated with zstd 1.5.7 (RustDesk compresses clipboard text with
 * `zstd::bulk::Compressor` level 3, which records the content size):
 *
 *   printf '%s' '远端剪贴板 hello' > known.txt
 *   zstd -19 -q -f known.txt -o known.zst         # content size present
 *   printf '%s' '流式剪贴板 stream' | zstd -19 -q -c > stream.zst
 *                                                   # content size omitted
 *
 * The stream variant exercises the no-content-size fallback (zstddec cannot
 * auto-detect the output size for such frames). Both were verified with
 * zstddec 0.0.2.
 */
export const CLIPBOARD_ZSTD = {
  text: '远端剪贴板 hello',
  knownSizeBase64: 'KLUv/SQVqQAA6L+c56uv5Ymq6LS05p2/IGhlbGxvtTULgw==',
  streamBase64: 'KLUv/QRosQAA5rWB5byP5Ymq6LS05p2/IHN0cmVhbcAwLRM=',
} as const;

export function clipBytesFromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
