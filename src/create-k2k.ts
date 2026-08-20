import {createDictAuto} from "bakak2k"
// kanji2koe-openjtalk 也是一个不错的选择

export default async function createK2K(path: string) {
  return await createDictAuto(new Uint8Array(await (await fetch(path)).arrayBuffer()))
}
