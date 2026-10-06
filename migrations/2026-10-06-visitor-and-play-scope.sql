-- ============================================================================
-- 迁移：游客编号（visitor）+ 游玩记录的出题范围（scope_province / scope_label）
--
-- 背景（2026-10 用户口径）：
--   1. 未登录的访问要给一个**稳定的 4 位编号**（如「游客1234」），用于区分不同游客；
--      同一个浏览器每次访问保持同一个号 —— 由前端写在 localStorage 里（见 src/visitorId.ts），
--      服务端只做形状校验后入库。故 access_logs 与 play_logs 各加一列 `visitor`。
--   2. 「游玩统计」要能看到**游玩模式 + 出题范围**两个维度，故 play_logs 再加
--      `scope_province`（哨兵/省 adcode）与 `scope_label`（展示名）。
--
-- ⚠ **部署前必须先执行本迁移**：functions/api/visit.ts 与 functions/api/play.ts 会向这些新列写数据。
--    代码侧对写入失败做了容错（只 console.warn、接口照旧返回 ok），所以**忘了跑迁移不会报错，
--    只会静默不记录**（新列全为空）—— 更难发现。管理端读到空列会退化成「游客」/「爬虫」与「—」。
--
-- 执行命令（在项目根目录）：
--   npx wrangler d1 execute china-admin-memory-db --remote --file=migrations/2026-10-06-visitor-and-play-scope.sql
--   npm run db:migrate:remote      # 等价的 npm 快捷方式
--   npm run db:migrate:local       # 本地 dev
--
-- 幂等性：SQLite 的 ALTER TABLE 没有 ADD COLUMN IF NOT EXISTS，重复执行会报
--   "duplicate column name: visitor" 之类的错误 —— 那说明这个库已经迁过了，忽略即可
--   （本文件没有 CREATE TABLE，全部是 ADD COLUMN）。
--
-- 新装库不需要本文件：schema.sql 已经是迁移后的最新结构（`npm run db:init:local` / `db:init:remote`）。
-- ============================================================================

-- 游客编号：4 位数字字符串；NULL = 老行或客户端未上报（前端退化成「游客」/「爬虫」）
ALTER TABLE access_logs ADD COLUMN visitor TEXT;

ALTER TABLE play_logs ADD COLUMN visitor TEXT;
-- 出题范围：标识（''/哨兵/6 位 adcode）与展示名（如「世界」「省级全国」「广东省」）。
-- 只作统计维度，不做白名单校验（见 functions/api/play.ts 的 cleanScope 说明）。
ALTER TABLE play_logs ADD COLUMN scope_province TEXT;
ALTER TABLE play_logs ADD COLUMN scope_label TEXT;
