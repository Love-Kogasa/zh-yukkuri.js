const path = require("path");
const webpack = require("webpack");

const STUB = path.resolve(__dirname, "node-stub");

module.exports = {
  mode: "production",
  entry: "./index.js",
  // 浏览器环境：v86 以内建的 WebAssembly 完成仿真，
  // Node 内建模块属于浏览器中永远不会执行到的分支，统一替换为空桩，
  // 使打包产物能直接通过 <script> 引入。
  target: "web",
  output: {
    path: path.resolve(__dirname),
    filename: "yukkuri-zh.dist.js",
    library: {
      name: "yukkuri", // 全局变量名 window.yukkuri
      type: "window",
    },
  },
  module: {
    rules: [
      {
        test: /\.m?js$/,
        parser: {
          // 将动态 import() 内联进主包，确保最终只有一个单文件 IIFE，
          // 不额外产出若干 .js 分片，方便 <script> 直接引入。
          dynamicImportMode: "eager",
        },
      },
    ],
  },
  resolve: {
    alias: {
      // CJS require("fs") / require("crypto") 等非 node: 前缀引入
      fs: STUB,
      crypto: STUB,
      os: STUB,
      path: STUB,
      util: STUB,
      buffer: STUB,
    },
    fallback: {
      url: path.resolve(__dirname, "node-stub/index.js"),
    },
  },
  plugins: [
    // 将 node:* 系内建模块（node:fs/promises、node:crypto 等）替换为空桩，
    // 统一指向 node-stub/index.js，避免 strict ESM 下解析裸目录失败。
    // CJS 侧的 require("fs").promises 由下方 alias（fs: 指向目录 node-stub）
    // 拼出子路径 node-stub/promises 处理。
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = path.join(STUB, "index.js");
    }),
  ],
};
