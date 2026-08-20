// SPDX-License-Identifier: MIT
// 复制自 https://github.com/y52en/aquestalk.js (src/) 并适配,原始许可见本目录 LICENSE

/** 字节与数字的转换助手(koeToSjis 用 verify 脚本同款内嵌表,见 oracle 使用方)。 */

export function to_bytes_uint32(num: number): Uint8Array {
  return new Uint8Array([
    num & 0x000000ff,
    (num & 0x0000ff00) >> 8,
    (num & 0x00ff0000) >> 16,
    (num & 0xff000000) >> 24,
  ]);
}

export function from_bytes_uint32(bytes: Uint8Array): number {
  return (
    (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
  );
}

export function uint8array_concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
}
