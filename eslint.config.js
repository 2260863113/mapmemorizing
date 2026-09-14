// ESLint 平铺配置（ESLint 9+ / 10）。
//
// 为什么是 ESLint 而不是 Prettier：Prettier 是**重写式**格式化器，实测它会把本仓库两处刻意
// 且一致的约定推翻 ——
//   1. D1 链式调用坚持 `prepare(...)` ⏎ `.bind(...)` ⏎ `.run()` 三行（约 20 个端点一致），
//      Prettier 只在整条 ≤140 列时才挤成一行，于是同一仓库里两种写法并存；
//   2. 紧凑单行方法 `enter() { void this.panel.show(); }`（appController 的 9 个 chrome 委托
//      也是这样写的），Prettier 一律展开成 4 行。
// 全仓 71 个文件需要重写、diff 会埋掉重构历史，收益不抵。ESLint **只报不改**，适合做回归守卫。
//
// 规则只挑「真实踩过或修过的问题」，不追求齐全：
//   · max-lines-per-function / max-lines —— 本轮把最长函数从 222 行砍到 52、最长文件从
//     1846 行砍到 1617；这两条防止它们长回去。
//   · no-unused-vars —— 本轮有 3 处导入在搬移后失效（normalizeProvince / worldFeatureVisible /
//     TIER_ZOOM_MIN），当时靠手写脚本才发现，本该由 lint 报出来；上线首轮又查出 8 处历史死代码。
//   · no-explicit-any —— 全仓当前 0 处，锁住它。
//   · no-console —— 入口与探针可以 warn/error，不许 log 残留。
import tseslint from 'typescript-eslint';

/** 不入库的一次性探针/临时目录（见 .gitignore），不参与 lint。 */
const GENERATED_OR_LOCAL = [
  'dist/**',
  'node_modules/**',
  '.wrangler/**',
  'public/**',
  'docs/**',
  'scripts/**', // 一次性 CDP 探针，非产品代码
  '.cnatlas-tmp/**',
  '.cnatlas-probe/**',
  '.world-src-probe/**',
  '.backup-data/**',
  'shot-world/**',
  'shot-compare/**',
  'shot-tier/**',
  'shot-seam/**',
  '**/*.mjs',
];

export default tseslint.config(
  { ignores: GENERATED_OR_LOCAL },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'functions/**/*.ts'],
    rules: {
      // —— 防止本轮修好的问题复发 ——
      // 阈值留出余量：当前最长函数 52 行（renderer.wireChartClick）、最长文件 1617 行。
      'max-lines-per-function': ['warn', { max: 60, skipBlankLines: true, skipComments: true }],
      'max-lines': ['warn', { max: 1700, skipBlankLines: true, skipComments: true }],

      // —— 死代码与类型逃逸 ——
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',

      // —— 基础正确性 ——
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // 诊断视图（rendererDiagnostics / quizDiagnostics）返回的是**活值 getter**，
      // 而对象字面量里的 getter 无法用 `this` 指向外层实例，必须 `const self = this`。
      // 这里只放行 `self` 这一个名字，别处照旧禁止。
      '@typescript-eslint/no-this-alias': ['error', { allowedNames: ['self'] }],
    },
  },
  {
    // 测试与验收探针：`describe` 块天生很长，探针工厂是一个方法集合，
    // 拿函数长度去要求它们没有意义。探针本来也不进产物（?probe=1 才加载）。
    files: ['**/*.test.ts', 'src/probe/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-lines': 'off',
    },
  },
);
