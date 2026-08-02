#!/usr/bin/env bash
# yukkuri-zh 前端打包脚本
#
# 作用：
#   将本项目（index.js 及其依赖）打包成浏览器可直接通过 <script> 引入的
#   IIFE 模块，输出为 yukkuri-zh.dist.js，全局变量名为 yukkuri。
#
# 用法：
#   ./build.sh
#
set -euo pipefail

# 切换到脚本所在目录，保证在任意目录下执行都正确
cd "$(dirname "$0")"

echo "==> [1/3] 安装依赖（含 webpack 与 v86 等运行库）..."
npm install

echo "==> [2/3] 执行 webpack 打包..."
npm run build

echo "==> [3/3] 校验产物..."
if [ -f "yukkuri-zh.dist.js" ]; then
  SIZE=$(wc -c < "yukkuri-zh.dist.js" | tr -d " ")
  echo "    成功生成 yukkuri-zh.dist.js（${SIZE} 字节）"
  echo "    在前端通过 <script src=\"yukkuri-zh.dist.js\"></script> 引入后，"
  echo "    使用全局变量 window.yukkuri.load(zipPath, dllPath, option) 即可。"
else
  echo "    错误：未找到 yukkuri-zh.dist.js" >&2
  exit 1
fi
