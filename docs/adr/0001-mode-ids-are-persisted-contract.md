# Mode id 字符串是不可变持久化契约

本次前端重构把各模式的类与文件按业务含义重命名（`selfTest.ts`→`input.ts` 的 `InputMode`、`memory.ts`→`freeBrowse.ts` 的 `FreeBrowseMode`、`free.ts`→`analysis.ts` 的 `AnalysisMode`），但每个 `BaseMode` 子类的 `id` 属性字符串保持原值不变：`'self'`、`'click'`、`'endless'`、`'free'`、`'memory'`、`'board'`、`'admin'`。

这些 id 同时被写入两处持久化存储：Cloudflare D1 排行榜表的 `mode` 字段，以及浏览器 localStorage 的模式相关键。二者共同构成「已上线数据的契约」，一旦改动 id 就会让历史成绩无法匹配到对应模式、本地状态键失效。

类名/文件名是只影响源码可读性的内部命名，可以随意改；id 字符串是跨版本、跨存储的对外契约，除非做显式的数据迁移，否则永远不能改。

**Status**: accepted

**Consequences**: 重构时看到语义上「不够直白」的 id（例如熟练度分析模式 id 是 `'free'` 而非 `'analysis'`）是刻意为之，不要顺手「修正」。新增模式时应分配新的、未曾使用过的 id，而不是复用或改名旧 id。

**补记（2026-09）**：`'memory'`（自由模式）已在本轮**整体下线**，它的 id 从 `Mode` 联合类型与各分支中删除。这不违反本 ADR —— 该 id 从未进入 D1（排行榜白名单只有 `self`/`click`/`endless`/`puzzle`，自由模式不提交成绩），仅有两个本地键，处理方式：`china-admin-memory-hide-labels-v1` 的值迁移为新的全局设置 `showBrowseLabels`（取反），`china-admin-mode-granularity:memory` 直接丢弃（已无用途）。**判断标准**：只有在「该 id 从没写过 D1、且本地键都有迁移或明确的丢弃理由」时，删除一个模式 id 才是安全的；否则必须先做数据迁移。
