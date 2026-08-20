/**
 * 第一级 —— 文本 → 假名 id 流。
 *
 * koeToSjis:入口契约(字符串进,Shift-JIS 字节出;出现无法编码的
 * 字符返回 null,对应错误 105)。
 * parseKana:查表解析,从表尾向前扫描取**最长匹配**(单字节控制标点
 * 与 2~6 字节的假名条目一视同仁);遇到控制字节(≤0x20)截断后续,
 * 有字节匹配不上则整句失败。
 */
import type { Voice } from "../core/types.js";
import { KANA_CHAR_TO_SJIS } from "./kana-map.js";

/** 假名字符串 → Shift-JIS 字节;Latin-1 字符原样透传;其余 → null(105)。 */
export function koeToSjis(koe: string): Uint8Array | null {
  const out: number[] = [];
  for (const ch of koe) {
    const b = KANA_CHAR_TO_SJIS[ch];
    if (b) {
      out.push(...b);
      continue;
    }
    const c = ch.codePointAt(0)!;
    if (c <= 0xff) {
      out.push(c);
      continue;
    }
    return null;
  }
  return new Uint8Array(out);
}

/**
 * 把 Shift-JIS 输入解析成假名 id 序列(id 就是引擎内部的音素类型字节)。
 * 每个位置都从 KANA 表的**末尾**向前找匹配(最长/最靠后的条目获胜),
 * 因此拗音之类的多字符条目优先于单假名条目被吃掉。
 */
export function parseKana(input: Uint8Array, voice: Voice): number[] | null {
  const kanaTable = voice.tables.KANA;
  const seq: number[] = [];
  let i = 0;
  while (i < input.length) {
    const b = input[i];
    if (b <= 0x20) break; // 控制字符:解析到此为止,后面的全部丢弃
    if (b === 0x3c /* '<' */) {
      // 标记标签:跳到下一个 '>'(尽力而为,与原版一致)
      const end = input.indexOf(0x3e, i);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    let matched: { bytes: number[]; id: number } | null = null;
    for (let k = kanaTable.length - 1; k >= 0; k--) {
      const e = kanaTable[k];
      const nb = e.bytes.length;
      if (nb === 0 || nb > 6) continue;
      if (i + nb > input.length) continue;
      let ok = true;
      for (let j = 0; j < nb; j++) {
        if (input[i + j] !== e.bytes[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matched = e;
        break;
      }
    }
    if (!matched) return null; // 错误 105:整句失败
    seq.push(matched.id);
    i += matched.bytes.length;
  }
  return seq;
}

/** 在第一个控制字符处截断 —— 原版引擎会丢弃其后的全部内容。 */
export function truncateAtControl(input: Uint8Array): Uint8Array {
  for (let i = 0; i < input.length; i++) {
    if (input[i] <= 0x20) return input.subarray(0, i);
  }
  return input;
}
