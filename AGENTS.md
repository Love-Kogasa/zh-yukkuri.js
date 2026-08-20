# AGENTS.md — 本仓库的 agent 协作说明

给 AI 编程助手的工作规矩。人类读者请看 README(门面)和 docs/ENGINE.md(引擎来历)。

## 项目一句话

对 AquesTalk 的中文适配封装(v2 起内置纯 JS 合成引擎,不再需要 v86.wasm / DLL zip)。
8 个 voice:f1 / f2 / r1 / m1 / m2 / dvd / jgr / imd1;语速 50..300。

## 命令速查(需要 Node ≥ 20.17)

| 命令 | 验什么 |
|---|---|
| `npm i` | 装依赖 |
| `npm run typecheck` | tsc --noEmit,零错才继续 |
| `npm test` | jest:16 例引擎 golden 冒烟 + 3 例 load 契约 |
| `npm run build` | tsdown → 根目录 yukkuri-zh.dist.js(单文件 IIFE,下游契约) |
| `npm run verify` | (可选)与原版 DLL 逐字节交叉对比;需 Node ≥ 22.6 + 自取资产 |

**任何 src/ 改动后必须依次跑:typecheck → test → build。**
verify 不进 CI、不强制(资产不入库);有资产时,引擎行为变更后建议加跑。
用法/前置/自定义用例 TSV 格式见 `verify/verify.mts` 头注释。
build 产物变更时的冒烟(可整段复制):

```bash
node --input-type=module -e "
globalThis.window = globalThis;
const src = await (await import('node:fs/promises')).readFile('./yukkuri-zh.dist.js','utf8');
(0, eval)(src);
const y = window.yukkuri;
const aq = await y.load({ map: 'ni\tニ\nhao\tハオ\n' });
console.log('wav bytes:', (await aq.run('こんにちわありがとう')).length);
try { await aq.run('あっ'); } catch (e) { console.log('err102 ok:', String(e).includes('102')); }
"
```

期望输出 `wav bytes: 20956` 和 `err102 ok: true`。

## 仓库地图

```
src/index.ts        适配层:load() 兼容入口 + ESM 导出(Converter/createK2K/synth 等)
src/converter.ts    拼音→假名(pinyin-to-kana + 数字转中文)
src/resources.ts    资源 URL 辅助
src/create-k2k.ts   BakaK2K 字典加载(beta 路线)
src/engine/         ★ 合成引擎(冻结的已验证产物,见下节)
  ├─ index.ts       五级流水线驱动 + synth()/run()
  ├─ voice.ts       voice 常量 + 假名 id→音素名映射
  ├─ core/          类型契约 + 共享缓冲区(残留机制的内存模型)
  ├─ pipeline/      解析 → 归一化 → 分词音高 → 音素展开 → 帧合成
  ├─ render/        波形渲染(激励源 + FIR 滤波,A/B 渲染族)
  └─ data/          8 个 voice 的参数表(提取产物)
tests/              jest 测试(engine 冒烟 + load 契约)
verify/             (可选)与原版 DLL 的交叉验证(v86 模拟器,含 third-party 许可;资产 gitignore 自取)
.github/workflows/  CI(push/PR 时跑 typecheck → build → 体积 sanity → test)
tsdown.config.ts    构建配置(IIFE 契约、文件名插件、依赖内联清单)
jest.config.cjs     测试配置(模块映射 + ESM 放行,动它前先看"已知坑")
docs/ENGINE.md      引擎来历与验证方法(人类叙事)
CHANGELOG.md        变更记录(v2 起维护,Keep a Changelog 风格)
yukkuri-zh.dist.js       下游直接 <script> 引入的产物(仓库根,沿用 1.x 路径;构建生成,勿手改)
```

## 硬约束(NEVER)

1. **对外契约不可破**:
   - 构建产物是单文件 IIFE,全局名 `window.yukkuri`,文件名 `yukkuri-zh.dist.js`(仓库根,沿用 1.x 路径,CDN 直链不变);
   - `load(option)` 单参数签名(v2 起清理,1.x 的 zippath/dllpath 已移除);
   - 实例形状 `{ koe, run, destroy }`;`run()` 对合成错误 **throw**(下游有 catch);
   - 错误码 102(音素规则拒绝)/ 105(无法解析)与原版一致,不可改语义。
2. **`src/engine/` 的行为语义不可"顺手修"**(见下节协议)。
3. **`src/engine/data/` 与 voice 常量不可手改**——它们是从原版引擎逐字节提取的,
   手改即破坏逐字节等价。
4. **不新增运行时依赖**(产物单文件体积敏感)。若确有必要:package.json dependencies
   + tsdown.config.ts 的 `deps.alwaysBundle` 列表必须同步加,且确认产物仍为单文件。
5. **测试框架是 jest**。不要引入 bun/vitest,不要把测试改成别的运行器。
6. **IIFE 输出文件名由 tsdown 插件固定**(`fixedName` → 根目录 `yukkuri-zh.dist.js`,且 `clean:false`
   防止清空仓库根)。下游用 `<script>` 引用这个文件名,改它属于破坏性变更。

## 引擎修改协议

引擎是经过大规模逐字节验证的**冻结产物**。仓库里没有原版 DLL 与验证设施,
因此这里不是判断"引擎行为对不对"的地方。规则:

- **修引擎 bug 前必须先用测试固定现状**:在 tests/engine.test.ts 加一个
  复现该行为的用例(即使它看起来是 bug),确认红灯原因后再动手。
- 行为级修改的唯一正当理由是**修复真实的偏离**,且修改后必须全量重跑
  typecheck → test → build → 冒烟(有 verify 资产时再加跑 `npm run verify`);
  任何既有用例变红都意味着破坏了等价性。
- 新增测试用例的采样方式:用 `src/engine/index.js` 的 `synth()` 跑一次,
  对 wav 做 sha256 取前 16 位十六进制填入 `hash` 字段;错误路径填 `err`。
- 拿不准的"怪行为" → 查该文件头部注释(每个反直觉行为都写了为什么),
  注释没覆盖的,保持现状并在 PR 里描述观察。

### 防误修索引(看似 bug,实为忠实行为)

| 现象 | 为什么是这样 |
|---|---|
| 句尾促音(`あっ`)报 102,但 `い,あっ` 正常出声 | 原版读共享缓冲区残留:首短语残留是零→报错;后续短语读到上一短语的帧记录→能出声。见 core/synth-arena.ts |
| m2 的单音节周期是 687 而非公式值的 686 | 原版实测如此,差 1 是特例常量 |
| 负音高按无符号除法、标志位泄进帧尺寸 | 原版整数运算的真实语义,见 pipeline/tokenize.ts 尾部注释 |
| 个别输入(`漢字`)整句报 105 而非跳过 | 原版语义是整句失败,不是容错跳过 |
| 错误时 throw 而非返回空 | 原版 DLL 实例的行为,下游依赖 catch 分支提示用户 |

## 代码风格

- TypeScript strict;**禁用 `var`**;导出优先 const/函数。
- 注释用中文,写给人类读者;**禁止反汇编式术语**(函数地址、十六进制偏移之类)
  和内部版本代号——描述行为与原理,不描述考古过程。
- 新文件进对应目录,遵循现有 import 风格(`.js` 后缀的相对导入)。

## 已知坑

- **bakak2k 是 ESM-only 包**:jest 能跑它靠 jest.config.cjs 里
  `transformIgnorePatterns` 的放行——"清理"这行配置会让测试挂掉。
- **tsdown 的 `deps.alwaysBundle`**:不加它,运行时依赖会被 external 掉,
  产物会变成需要全局变量的残废包(症状:IIFE 尾部出现 `wanakana` 等标识符引用)。
- 转换链依赖 `option.map`(pinyin-to-kana 的 mapping.tsv 内容),
  不传时拼音转换不工作——这是上游设计,不是 bug。

## 实现引擎时踩过的认知坑(改引擎前必读)

这些是复刻过程中最难缠的错误来源——每一个都曾让"看起来对"的实现
在逐字节对比下暴露。共性与教训写在最后一条。

- **整数语义错一处,后面全错。** 除法不是四舍五入而是"向零截断";插值
  乘法带符号偏置后右移;音高除法里除数按**无符号 16 位**读(负音高不按
  负数除)。速度非 2 的幂时(如 150),截断 vs 舍入会差一个样本,
  之后全部 PCM 错位。
- **提取数据的表边界不可信。** 参数表末行与相邻表重叠(连续内存),
  提取脚本硬编码的表长会截短;音素名表的头尾有指针伪影。任何
  "数据文件里这个表好像少了/多了几行"的直觉都可能是提取问题,
  不是引擎问题。
- **上下文规则必须在 id 层做,不能在名字层猜。** 同一假名的名字
  会因位置变化(词首/词中/大写元音体),靠名字反推上下文规则
  在某些组合下碰巧等价、另一些组合下全错。
- **跨短语的"脏内存"是特性不是 bug。** 见防误修索引首条:很多
  "诡异"的拒绝/出声行为根因都是残留字节的解读,把它"修干净"
  等于引入偏差。
- **某些行为只在特定输入域暴露。** 全平假名的测试永远测不出
  片假名问题(真实语料是片假名);促音×控制字的组合也不在常规
  测试里。新增用例时优先选这些盲区形态。
- **教训(共性):** 引擎里任何"看起来能化简/修正"的地方,大概率
  是逐字节对比修正过的结果。改之前先假定现状是对的,用测试固定它;
  验证手段只有"与已知正确的输出对比",没有"从原理推导"。
