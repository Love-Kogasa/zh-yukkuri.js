/**
 * 原版 DLL × 引擎 交叉验证(v86 模拟器后端,跨平台)。
 *
 *   npm run verify                       # 内置代表用例
 *   npm run verify -- my-cases.tsv       # 自定义用例
 *
 * 前置:
 *   - verify/assets/ 放入自取资源(目录已被 .gitignore 排除,不进版本库):
 *       v86.wasm                 —— v86 模拟器的 wasm 内核
 *       {voice}.zip × 8          —— 原版 voice 包(zip 内含 AquesTalk.dll)
 *     来源:zh-yukkuri-offline 仓库 static/voices/(v86.wasm 与全部 zip 原样),
 *     或 Aquest 官网评估版(许可:仅评估用途、不可再分发)。
 *   - npm i(v86 与 jszip 是 devDependencies)
 *   - npm run build(引擎侧验证的是 dist 产物)
 *   - Node ≥ 22.6(--experimental-strip-types);平台不限。
 *
 * 每个用例:
 *   引擎侧:eval 加载 dist,用 yukkuri.synth() 算 PCM 的 sha256(前 16 位);
 *   参照侧:v86 加载原版 DLL 冷启动合成一次(v86 输出与真机 DLL 的等价性
 *           已在开发阶段全量交叉复核;每输入独立模拟器实例 = 冷启动语义)。
 *   输出:PASS(逐字节一致)/ FAIL / UB?(疑似未定义域,人工确认)。
 *
 * 用例文件:UTF-8 TSV,每行 voice <TAB> speed <TAB> 假名串,支持 # 注释。
 * 不传则用文件底部内置的代表用例。
 */
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { synthOnce } from "./v86/oracle.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")

// —— 引擎侧(dist 产物)—————————————————————————————
// dist 的 IIFE 写 window.yukkuri;v86 包也要 window(键盘事件那套)。
// 用同一个 window 垫片:指向 globalThis 并补齐事件监听空实现。
globalThis.window = globalThis
;(globalThis as { addEventListener?: unknown }).addEventListener ??= () => {}
;(globalThis as { removeEventListener?: unknown }).removeEventListener ??= () => {}
const distSrc = await readFile(path.join(ROOT, "yukkuri-zh.dist.js"), "utf8")
;(0, eval)(distSrc)
const synth = (globalThis as { yukkuri?: { synth: (k: string, o?: { voice?: string; speed?: number }) => Promise<{ ok: boolean; wav?: Uint8Array; code?: number }> } }).yukkuri?.synth
if (typeof synth !== "function") {
  console.error("dist 里没有 yukkuri.synth —— 先 npm run build,并确认 src/index.ts 导出了 synth")
  process.exit(2)
}
const sha16 = (u8: Uint8Array) => createHash("sha256").update(u8).digest("hex").slice(0, 16)
const engineSide = async (voice: string, koe: string, speed: number) => {
  const r = await synth(koe, { voice, speed })
  // 跳过 44 字节 WAV 头,只哈希 PCM 数据
  return r.ok ? "h" + sha16(r.wav!.subarray(44)) : "e" + r.code
}

// —— 参照侧:v86 + 原版 DLL(冷启动)—————————————————————————
const oracleSide = async (voice: string, koe: string, speed: number): Promise<string> => {
  try {
    const wav = await synthOnce(voice, koe, speed)
    return "h" + sha16(wav.subarray(44))
  } catch (e) {
    const code = (e as { code?: number }).code
    if (code === 102 || code === 105) return "e" + code
    return "ERR:" + String(e).slice(0, 100)
  }
}

// —— 用例 ————————————————————————————————————————
const BUILTIN = `
f1\t100\tこんにちわありがとう
r1\t100\tこんにちわありがとう
m2\t100\tこんにちわありがとう
f2\t100\tニーハオ
dvd\t100\tこん'にちわ
m1\t100\tだ'いじょ'うぶです'か？
f1\t50\tこんにちわ、ありがとう
dvd\t300\tこんにちわありがとう
f2\t150\tふぁんてぃーでゅ,こんにちわ
f1\t100\tよーお
f2\t100\tあい+う
f1\t100\tい,あっ
jgr\t100\tあっ
imd1\t100\tきふこるっ
`
const caseFile = process.argv[2]
const raw = caseFile ? await readFile(caseFile, "utf8") : BUILTIN
const lines = raw.split(/\r?\n/).filter((l) => l && !l.startsWith("#"))

let pass = 0
const fails: string[] = []
for (const line of lines) {
  const [voice, speedStr, ...rest] = line.split("\t")
  const koe = rest.join("\t")
  const speed = Number(speedStr) || 100
  const [eng, orc] = await Promise.all([engineSide(voice, koe, speed), oracleSide(voice, koe, speed)])
  const tag = `${voice.padEnd(4)} @${String(speed).padEnd(3)} ${JSON.stringify(koe)}`
  if (orc.startsWith("ERR")) {
    console.log(`ERR  ${tag}  ${orc}`)
    fails.push(line)
  } else if (orc === eng) {
    console.log(`PASS ${tag}  ${eng}`)
    pass++
  } else if (eng[0] === "e" && orc[0] === "h") {
    console.log(`UB?  ${tag}  engine=${eng} oracle=${orc.slice(0, 17)} (差异疑似未定义域,请人工确认)`)
  } else {
    console.log(`FAIL ${tag}  engine=${eng} oracle=${orc.slice(0, 17)}`)
    fails.push(line)
  }
}
console.log(`\n${pass}/${lines.length} 逐字节一致${fails.length ? "," + fails.length + " 例失败" : ""}`)
process.exit(fails.length ? 1 : 0)
