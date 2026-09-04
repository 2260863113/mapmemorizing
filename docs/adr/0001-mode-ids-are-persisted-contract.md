# Mode id 字符串是不可变持久化契约

本次前端重构把各模式的类与文件按业务含义重命名（`selfTest.ts`→`input.ts` 的 `InputMode`、`memory.ts`→`freeBrowse.ts` 的 `FreeBrowseMode`、`free.ts`→`analysis.ts` 的 `AnalysisMode`），但每个 `BaseMode` 子类的 `id` 属性字符串保持原值不变：`'self'`、`'click'`、`'endless'`、`'free'`、`'memory'`、`'board'`、`'admin'`。

这些 id 同时被写入两处持久化存储：Cloudflare D1 排行榜表的 `mode` 字段，以及浏览器 localStorage 的模式相关键。二者共同构成「已上线数据的契约」，一旦改动 id 就会让历史成绩无法匹配到对应模式、本地状态键失效。

类名/文件名是只影响源码可读性的内部命名，可以随意改；id 字符串是跨版本、跨存储的对外契约，除非做显式的数据迁移，否则永远不能改。

**Status**: accepted

**Consequences**: 重构时看到语义上「不够直白」的 id（例如熟练度分析模式 id 是 `'free'` 而非 `'analysis'`）是刻意为之，不要顺手「修正」。新增模式时应分配新的、未曾使用过的 id，而不是复用或改名旧 id。
