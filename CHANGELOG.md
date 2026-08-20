# Changelog

本文件自 v2 起维护。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [2.0.0] - 未发布

### 新增
- 内置纯 JS 合成引擎(vendored 自 [y52en/aquestalk.js](https://github.com/y52en/aquestalk.js)):
  加载单个 `yukkuri-zh.dist.js`(路径沿用 1.x)即可离线合成,不再需要 v86.wasm 与
  各 voice 的 DLL zip;输出与原版 DLL 逐字节一致(验证声明见 docs/ENGINE.md)
- `synth()` Result 风格 API:错误显式返回 `{ok:false, code:102|105}`
- jest 测试(引擎 golden 冒烟 + load 契约)、CI、AGENTS.md、docs/ENGINE.md
- `npm run verify`:与原版 DLL 的逐字节交叉验证工具(原版素材自取,不入库)

### 变更
- 全仓 TypeScript 化;构建从 webpack/build.sh 迁移到 tsdown
- **BREAKING**:`load()` 签名改为单参数 `load(option)` —— 1.x 的
  zippath/dllpath 两参数随内置引擎移除,旧调用点需更新
- 运行时需下载资源 ~2.6MB → 0;单句合成毫秒级(旧路径换声库需重新下载资源并初始化 v86,秒级)

### 移除
- `aquestalk.js` npm 依赖(引擎已内置)、webpack 配置、node-stub

### 修复
- converter 拼音未匹配时引用未定义变量
