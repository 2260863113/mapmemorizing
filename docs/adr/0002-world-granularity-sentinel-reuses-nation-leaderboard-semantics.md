# 世界粒度以哨兵 `__world_nation__` 复用“全国”排行榜语义而非新增枚举

在输入/点击模式的分段按钮中加入「世界」粒度后，用户需要一条独立的全球排行榜作用域。本系统已有两条作用域编码：市级全国 `''`（D1 中存空串）、省级全国哨兵 `__province_nation__`、单省 6 位 adcode。新增「世界全国」时选择再引入一个哨兵常量 `__world_nation__`（前端 `src/province.ts` 与后端 `functions/_lib/validate.ts` 各自维护、字面量一致），而不是为世界榜新增一列枚举或独立表。

**Status**: accepted

**Considered Options**: ① 排行榜表新增 `granularity` 列——需迁移 schema 与全部既有行，代价高且单列只对新增粒度有意义；② 复用 `__province_nation__` 哨兵——会让世界成绩与省级成绩在同一 `scope_province` 行上互相覆盖（DB UNIQUE(user_id, mode, scope_province)），且省级是全对/按用时的排序语义，无法表达世界榜「答对题数优先、同数比用时」的排序。最终选择独立的 `__world_nation__` 哨兵字符串，天然形成第三个 UNIQUE 作用域行。

**Consequences**: 世界榜成绩提交资格与排序与市级全国完全一致（`correct > 0 && wrong === 0`，按 correct 降序、elapsed_ms 升序）——前后端 `validate.ts`/`score.ts`/`leaderboard.ts` 以及前端 `scoreRules.ts`/`leaderboardPanel.ts` 中所有「是否全国语义」的判断都要把 `__world_nation__` 与 `null/''` 一并对待；把该哨兵当成普通“单省作用域”会错误落入省级时间榜分支。这两套映射（前端 vs 后端）必须始终同步，改动其中一处时要同时改另一处。
