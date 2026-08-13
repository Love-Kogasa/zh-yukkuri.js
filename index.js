import Converter from "./converter.js"
import {loadAquesTalk} from "aquestalk.js"
import * as Resource from "./resources.js"
import createK2K from "./createK2k.js"
import {toKatakana} from "wanakana"

export async function load(zippath, dllpath, option) {
  if(zippath && dllpath) {
    var aqtk = await loadAquesTalk(zippath, dllpath, option)
  } else {
    console.warn("Zip和Dll路径均不能为空，AQTK将不会被加载")
    var aqtk = {}
  }
  var kanaify = new Converter(option.map)
  var k2k = option.k2k || {toKana: toKatakana}
  var self
  return (self = {
    run: (koe, spd) => aqtk.run(self.koe(koe), spd),
    destroy: () => aqtk.destroy(),
    koe: (str) => k2k.toKana(kanaify.koe(str)).replaceAll(" ", ",")
  })
}

export {Converter}
export {Resource}
export {createK2K}
