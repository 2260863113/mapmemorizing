/**
 * 验收探针的入口（实现见 `probe/` 目录）。
 *
 * 为什么入口单独占一个顶层文件、而不是直接 `import('./probe/index')`：
 * Rollup 按**入口文件的 basename** 给动态 chunk 命名。入口是 `probe/index.ts` 时
 * chunk 会叫 `index-<hash>.js`，与主包 `index-<hash>.js` 同名 —— 在构建输出和浏览器
 * Network 面板里就没法一眼确认「普通用户到底有没有拉取探针」，而这正是本项目的一条
 * 验收性质。
 *
 * 注意**不要**改用 `build.rollupOptions.output.manualChunks` 来命名：实测它会把
 * echarts 等共享依赖一并拖进该 chunk，并把 `probe-*.js` 变成 index.html 的**静态**
 * 引用（每个用户都会下载 1.1 MB），恰好破坏上面那条性质。入口 shim 是零风险的。
 */
export { installProbe } from './probe/index';
