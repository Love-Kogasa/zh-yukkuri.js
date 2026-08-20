/** Untyped runtime deps (no @types on npm) — shapes as used by this repo. */
declare module "pinyin-to-kana" {
  export default class PinyinToKana {
    constructor(map: string)
    pinyinToKana(s: string): string
  }
}
declare module "number-to-chinese-words" {
  const ChineseNumber: { toWords(n: number): string }
  export default ChineseNumber
}
declare module "bakak2k" {
  export function createDictAuto(
    data: Uint8Array,
  ): Promise<{ toKana: (s: string) => string }>
}
declare module "tiny-pinyin" {
  interface PinyinToken {
    type: number
    source: string
    target: string
  }
  const Pinyin: {
    parse(s: string): PinyinToken[]
  }
  export default Pinyin
}
