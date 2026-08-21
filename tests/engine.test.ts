/**
 * 引擎冒烟测试 —— 内置引擎 vs 已知正确期望值。
 * 期望值来自上游仓库的 22177 例 DLL 逐字节验证(含 Windows 真机
 * 32 位原生 DLL 交叉复核);这里取一个小而全的固定样本,让本仓在
 * 不依赖任何 v86/DLL 的情况下也能抓住引擎同步带来的回归。
 *
 * 用例按输入域覆盖:8 voice 全覆盖、平假名/片假名、重音、标点、
 * 长音、促音(词中/句尾/跨短语)、控制字、速度边界、错误码 102/105。
 */
import { describe, expect, test } from "@jest/globals"
import { synth, run } from "../src/engine/index.js"
import { createHash } from "node:crypto"

const h = (u8: Uint8Array) => createHash("sha256").update(u8).digest("hex").slice(0, 16)

// { voice, koe, speed, hash | err } —— 采样值与原版 DLL 逐字节一致。
const CASES: Array<{ voice: string; koe: string; speed: number; hash?: string; err?: 102 | 105 }> = [
  // —— 8 voice 基线(平假名)——
  { voice: "f1", koe: "こんにちわありがとう", speed: 100, hash: "19ebd9c798e9c1e8" },
  { voice: "r1", koe: "こんにちわありがとう", speed: 100, hash: "c756daa5f132dcfe" },
  { voice: "m2", koe: "こんにちわありがとう", speed: 100, hash: "92598758784721aa" },
  // —— 片假名域(zh-yukkuri 真实输入形态)——
  { voice: "f2", koe: "ニーハオ", speed: 100, hash: "9cf632d67c15c463" },
  // —— 重音 ' 与 ？ 升调 ——
  { voice: "dvd", koe: "こん'にちわ", speed: 100, hash: "83e78e5c98e375b6" },
  { voice: "m1", koe: "だ'いじょ'うぶです'か？", speed: 100, hash: "f67b13ebfbd673db" },
  // —— 标点短语切分 + 速度边界 ——
  { voice: "f1", koe: "こんにちわ、ありがとう", speed: 50, hash: "dd7e1c7239a77cfe" },
  { voice: "dvd", koe: "こんにちわありがとう", speed: 300, hash: "e5d11ea215d93c46" },
  { voice: "f2", koe: "ふぁんてぃーでゅ,こんにちわ", speed: 150, hash: "ea6a95c08c3f5005" },
  // —— 长音 / 控制字 + ——
  { voice: "f1", koe: "よーお", speed: 100, hash: "7b2c254c8fbbe12c" },
  { voice: "f2", koe: "あい+う", speed: 100, hash: "4b33554779420b0d" },
  // —— 促音:跨短语幻影后继可渲染(与首短语拒绝对照)——
  { voice: "f1", koe: "い,あっ", speed: 100, hash: "8346bc3dcd71e908" },
  // —— 错误码:102(句尾促音)/ 105(不可编码字符)——
  { voice: "jgr", koe: "あっ", speed: 100, err: 102 },
  { voice: "imd1", koe: "きふこるっ", speed: 100, err: 102 },
  { voice: "f1", koe: "漢字", speed: 100, err: 105 },
]

describe("engine smoke", () => {
  for (const c of CASES) {
    test(`${c.voice} "${c.koe}" @${c.speed}`, async () => {
      const r = await synth(c.koe, { voice: c.voice as never, speed: c.speed })
      if (c.err !== undefined) {
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.code).toBe(c.err)
      } else {
        expect(r.ok).toBe(true)
        if (r.ok) expect(h(r.wav)).toBe(c.hash!)
      }
    })
  }

  test("run() 兼容:错误解析为空输出", async () => {
    const w = await run("あっ", { voice: "f1" })
    expect(w.length).toBe(0)
  })
})
