import PinyinToKana from "pinyin-to-kana"
import ChineseNumber from "number-to-chinese-words"
import Pinyin from "tiny-pinyin"
import {toKatakana} from "wanakana"

export default class Converter {
  constructor(map) {
    this.toKana = new PinyinToKana(map)
  }
  koe(string) {
    return toKatakana(
      this.kanaify(
        this.number(string)
      )
    )
  }
  kanaify(string) {
    return this.toKana.pinyinToKana(
      Pinyin.parse(string.replaceAll(" ", "_"))
        .map( t => t.type === 2 ? t.target + " " : t.source )
        .join( "" ))
      .replace("\n", " ")
      .replaceAll("_", " ")
      .replaceAll(" ", ",")
  }
  number(string) {
    return string.replace(/-{0,1}\d+(\.\d+){0,1}/g, num => {
      try {
        return ChineseNumber.toWords(Number (num))
      } catch(error) {
        return matched
      }
    })
  }
}
