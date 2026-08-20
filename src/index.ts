import Converter from "./converter.js"
import * as Resource from "./resources.js"
import createK2K from "./create-k2k.js"
import { toKatakana } from "wanakana"
import { synth as engineSynth, type SynthResult, type VoiceName } from "./engine/index.js"

export type { SynthResult, VoiceName }
export { Converter }
export { Resource }
export { createK2K }
/** 引擎入口直通(假名输入,不经拼音转换链)——验证工具与高级用法用这个。 */
export { synth, run } from "./engine/index.js"

export interface LoadOption {
  /** pinyin-to-kana 的 mapping.tsv 内容(必填,除非魔改了转换层) */
  map: string
  /** BakaK2K 实例(yukkuri.createK2K 的返回值);缺省用 wanakana 罗马字转片假名 */
  k2k?: { toKana: (s: string) => string }
  /** voice,默认 f1;合成时也可在 run 里覆盖 */
  voice?: VoiceName
}

export interface YukkuriInstance {
  run: (koe: string, spd?: number | string) => Promise<Uint8Array>
  destroy: () => void
  koe: (str: string) => string
}

/**
 * 加载入口:构建转换链并返回合成实例。
 *
 * v1 的 zippath/dllpath 两参数已随内置引擎移除(v2 breaking):
 * 引擎在 dist 里,不再需要外部资源。
 */
export async function load(option: LoadOption): Promise<YukkuriInstance> {
  const kanaify = new Converter(option.map)
  const k2k = option.k2k || {toKana: toKatakana}
  let self: YukkuriInstance
  return (self = {
    run: (koe: string, spd?: number | string) => engineRun(self.koe(koe), option.voice, spd),
    destroy: () => void 0,
    koe: (str: string) => k2k.toKana(kanaify.koe(str)).replaceAll(" ", ",")
  })
}

/** 错误同旧 DLL 实例:throw(下游 catch);不 throw 的入口用 engineSynth。 */
async function engineRun(koe: string, voice: VoiceName | undefined, spd?: number | string): Promise<Uint8Array> {
  const r = await engineSynth(koe, { voice, speed: Number(spd ?? 100) })
  if (!r.ok) throw new Error("AquesTalk error " + r.code + ": " + r.message)
  return r.wav
}
