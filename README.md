# zh-yukkuri.js
对[y52en/aquestalk.js](https://github.com/y52en/aquestalk.js)的中文适配包装
*我不懂日语，对一些词理解不准确，如有错误欢迎批评指出*

> **🚀 v2(本版本)**：合成引擎已内置为纯 JS 实现(`src/engine/`,vendored 自
> [y52en/aquestalk.js](https://github.com/y52en/aquestalk.js) 的 src/v2)
> ~~需要 v86.wasm + AquesTalk DLL zip(每个 voice 一个)~~
> 加载一个 `yukkuri-zh.dist.js`(仓库根,沿用旧路径)即可离线合成,运行时资源 ~2.6MB → 0,
> 单句合成毫秒级(桌面实测:热合成约 1-4ms,换声库首合成约 13ms;旧路径热合成数十 ms,
> 换声库需重新加载资源并初始化 v86,桌面实测约 0.3s,浏览器端另计 ~2.6MB 下载)。
> 项目也全面 TypeScript 化了。

# Usage
你只需要加载编译好的 yukkuri-zh.dist.js(仓库根,沿用旧路径)就足够了
TIP: 默认编译的结果是iife模块
```js
var aqtk = await yukkuri.load(option)
// 返回 { koe, run, destroy }:run() 输入中文(走拼音转换链)或假名,返回 wav(Uint8Array)
await aqtk.run("我是飞舞")
await aqtk.destroy() // 销毁(现为空操作)
```
不过通常来说你应该设置这几个值在设置里
```js
{
  ~~wasmPath: "v86.wasm",~~
  voice: "f1", // f1/f2/r1/m1/m2/dvd/jgr/imd1,默认f1
  map: "" // 用于中文转kanakata的tsv文件的内容
  // 从pinyin-to-kana npm包里拿mapping.tsv
  // 如果你不魔改模块的话这个值是必填的！
}
```

# Engine
~~这只是个壳，需要配合aqtk的dll用，你可以去a-quest官网找或者去y52en/aquestalk\.js 找~~
  v2 起引擎内置:8 voice、speed 50..300,输出与原 DLL **逐字节一致**
  (开发侧两万余组用例验证 + Windows 真机原生 DLL 交叉复核,
   来历与验证方法详见 [docs/ENGINE.md](docs/ENGINE.md))
* `src/engine/` 从上游单向同步(勿直接改,改了也会被下次同步覆盖)
- 错误契约:`synth()` 返回 `{ok:false, code:102|105}`;`load().run()` 对错误
  throw(同旧 DLL 实例行为);npm v1.0.5 风格的"错误→空输出"用 `engine/run()`

# Build
~~我最开始想用rollup弄得，结果弄了半天没成功~~
~~然后折腾了半天才让ds写~~
~~结果ds也没弄好换webpack了~~
v2 换成 tsdown(Rolldown 内核),顺带全仓 TypeScript 化:
```bash
npm i
npm run build     # tsdown → yukkuri-zh.dist.js (根目录, 单文件 IIFE, ~2.3MB)
npm test          # jest:引擎 golden 冒烟 + load() 契约
npm run typecheck # tsc --noEmit
npm run verify    # (可选)与原版 DLL 逐字节交叉对比
```
需要 Node ≥ 20.17(构建)。

verify 是开发侧重验证工具,不进 CI。运行前置:

- Node ≥ 22.6;`npm i`;`npm run build`(引擎侧验证的是根目录 yukkuri-zh.dist.js)
- `verify/assets/` 放入自取资源(目录已被 .gitignore 排除,不入库):
  - `v86.wasm` —— v86 模拟器的 wasm 内核
  - 8 个 voice zip:`f1.zip` / `f2.zip` / `r1.zip` / `m1.zip` / `m2.zip` /
    `dvd.zip` / `jgr.zip` / `imd1.zip`(zip 内含原版 AquesTalk.dll)
  - 来源:zh-yukkuri-offline 仓库 `static/voices/`(原样),或 Aquest 官网
    评估版(仅评估用途、不可再分发,故不入库)

自定义用例 TSV 格式与输出判定(PASS/FAIL/UB?)见 `verify/verify.mts` 头注释。

# Warning
引擎为学习逆向的实现,内置的 AquesTalk 数据表版权归 Aquest 所有,
**仅供学习与非商业用途**;商用请向 Aquest 购买授权。
BakaK2K(beta)与 small_dic/aqdic.bin 同属 Aquest SDK eval 资产,分发注意边界。

内联依赖均为 MIT:wanakana / pinyin-to-kana / number-to-chinese-words / tiny-pinyin / bakak2k。
