// 浏览器打包时的 Node 内建模块空桩。
// v86 仅在 Node 运行时会调用这些模块，浏览器中永远走不到，故导出空实现。
export const define = (o) => o;
export const promisify = () => () => Promise.resolve();
export const toSystemPath = (p) => p;
export default {};
