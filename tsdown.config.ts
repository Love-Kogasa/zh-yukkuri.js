import { defineConfig, type TsdownPlugin } from "tsdown"

/** 把 IIFE 入口的输出文件名固定为下游契约名(替代构建后的 rename 脚本)。 */
const fixedName = (name: string): TsdownPlugin => ({
  name: "fixed-output-name",
  outputOptions(options) {
    options.entryFileNames = name
    options.chunkFileNames = name
    return options
  },
})

export default defineConfig({
  entry: ["src/index.ts"],
  // 下游契约:单文件 IIFE + window.yukkuri,输出在仓库根(沿用 1.x 路径,
  // CDN 直链 https://cdn.jsdelivr.net/gh/.../yukkuri-zh.dist.js 不变)
  format: ["iife"],
  globalName: "yukkuri",
  outDir: ".",
  // outDir 是仓库根,禁止 clean(默认会拒绝清空工作目录)
  clean: false,
  minify: true,
  plugins: [fixedName("yukkuri-zh.dist.js")],
  deps: {
    // IIFE 单文件:运行时依赖必须全部内联(库模式默认 external 掉 dependencies)
    alwaysBundle: ["wanakana", "pinyin-to-kana", "number-to-chinese-words", "tiny-pinyin", "bakak2k"],
  },
})
