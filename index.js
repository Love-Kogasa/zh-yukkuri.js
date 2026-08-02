import Converter from "./converter.js"
import {loadAquesTalk} from "aquestalk.js"
import * as Resource from "./resources.js"

export async function load(zippath, dllpath, option) {
  var aqtk = await loadAquesTalk(zippath, dllpath, option)
  var kanaify = new Converter(option.map)
  return {
    run: (koe, spd) => aqtk.run(kanaify.koe(koe), spd),
    destroy: aqtk.destroy.bind(aqtk)
  }
}

export {Converter}
export {Resource}