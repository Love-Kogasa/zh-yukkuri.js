# zh-yukkuri\.js
对[y52en/aquestalk.js](https://github.com/y52en/aquestalk.js)的中文适配包装  
*我不懂日语，对一些词理解不准确，如有错误欢迎批评指出*  

# Build
我最开始想用rollup弄得，结果弄了半天没成功  
然后折腾了半天才让ds写  
结果ds也没弄好换webpack了  
构建命令
```bash
npm i
npm run build
# 或
./build.sh
```

# Usage
你只需要加载编译好的yukkuri-zh\.dist\.js就足够了  
TIP: 默认编译的结果是iife模块
```js
var aqtk = await yukkuri.load(zippath, dllpath/*zip文件里*/, option)
// 返回值和y52en/aquestalk.js的loadAquesTalk一样
await aqtk.run("我是飞舞") // 合成，返回wav字符
await aqtk.destroy() // 销毁
```
不过通常来说你应该设置这几个值在设置里
```js
{
  wasmPath: "v86.wasm",
  map: "" // 用于中文转kanakata的tsv文件的内容
  // 从pinyin-to-kana npm包里拿mapping.tsv
  // 如果你不魔改模块的话这个值是必填的！
}
```

# Warning
这只是个壳，需要配合aqtk的dll用，你可以去a-quest官网找或者去y52en/aquestalk\.js找  
特别小心**Aquest License**