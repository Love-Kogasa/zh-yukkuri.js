import Converter from "./converter.js"
import {loadAquesTalk} from "aquestalk.js"
import * as Resource from "./resources.js"
import createK2K from "./createK2k.js"
import {toKatakana} from "wanakana"

export async function load(zippath, dllpath, option) {
  var aqtk = await loadAquesTalk(zippath, dllpath, option)
  var kanaify = new Converter(option.map)
  var k2k = option.k2k || {toKana: toKatakana}
  return {
    run: (koe, spd) => aqtk.run(k2k.toKana(kanaify.koe(koe)), spd),
    destroy: aqtk.destroy.bind(aqtk),
    koe: kanaify.koe.bind(kanaify)
  }
}

export {Converter}
export {Resource}
export {createK2K}
