import PinyinToKana from "pinyin-to-kana"
import ChineseNumber from "number-to-chinese-words"
import Pinyin from "tiny-pinyin"

export default class Converter {
  toKana: PinyinToKana

  constructor(map: string) {
    this.toKana = new PinyinToKana(map)
  }
  koe(string: string): string {
    return this.kanaify(
      this.number(string)
    )
  }
  kanaify(string: string): string {
    return this.toKana.pinyinToKana(
      Pinyin.parse(string.replaceAll(" ", "_"))
        .map( t => t.type === 2 ? t.target + " " : t.source )
        .join( "" ))
      .replaceAll("\n", " ")
      .replaceAll("_", " ")
  }
  number(string: string): string {
    return string.replace(/-{0,1}\d+(\.\d+){0,1}/g, num => {
      try {
        return ChineseNumber.toWords(Number (num))
      } catch(error) {
        return num
      }
    })
  }
}
