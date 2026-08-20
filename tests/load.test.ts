/**
 * load() contract — the pure-JS engine instance shape
 * (window-free environment: only koe() and run()'s error path).
 */
import { describe, expect, test } from "@jest/globals"
import { load } from "../src/index.js"

// minimal mapping.tsv — the real one ships with zh-yukkuri-offline
const MAP = "ni\tニ\nhao\tハオ\n"

describe("load()", () => {
  test("koe() converts + spaces to commas (wanakana fallback)", async () => {
    const aq = await load({ map: MAP })
    // fallback k2k is wanakana toKatakana: pinyin table handles ニーハオ
    const k = aq.koe("ni hao")
    expect(typeof k).toBe("string")
    expect(k.includes(",")).toBe(true)
  })

  test("run() throws on DLL-equivalent error", async () => {
    const aq = await load({ map: MAP })
    await expect(aq.run("あっ")).rejects.toThrow("102")
  })

  test("destroy() is a no-op", async () => {
    const aq = await load({ map: MAP })
    expect(aq.destroy()).toBeUndefined()
  })
})
