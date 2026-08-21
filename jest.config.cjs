/** Jest 配置 —— CJS 转换模式下跑 ESM 源码。
 *  · moduleNameMapper 把 ".js" 后缀的相对导入指回 .ts 源文件
 *  · bakak2k 是 ESM-only 包,单独放行给 ts-jest 转换
 */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  moduleFileExtensions: ["ts", "js", "json"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.(ts|js)$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node",
          verbatimModuleSyntax: false,
          allowJs: true,
          esModuleInterop: true,
        },
      },
    ],
  },
  transformIgnorePatterns: ["/node_modules/(?!bakak2k)"],
};
