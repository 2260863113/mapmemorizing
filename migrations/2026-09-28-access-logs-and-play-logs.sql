-- ============================================================================
-- 迁移：访问日志补 IP / 地理 / 环境 / 爬虫判定 + 新增游玩日志表（play_logs）
--
-- ⚠ **部署前必须先执行本迁移**：functions/api/visit.ts 与 functions/api/play.ts 会向
--    access_logs / play_logs 的新列写数据。代码侧对写入失败做了容错（只 console.warn、
--    接口照旧返回 ok），所以**忘了跑迁移不会报错，只会静默不记录** —— 更难发现。
--
-- 执行命令（在项目根目录，把库名换成 wrangler.toml 里的 database_name）：
--   npx wrangler d1 execute china-admin-memory-db --remote --file=migrations/2026-09-28-access-logs-and-play-logs.sql
--   npx wrangler d1 execute china-admin-memory-db --local  --file=migrations/2026-09-28-access-logs-and-play-logs.sql
--
-- 幂等性：SQLite 的 ALTER TABLE 没有 ADD COLUMN IF NOT EXISTS，重复执行会报
--   "duplicate column name: ip" 之类的错误 —— 那说明这个库已经迁过了，忽略即可，
--   后面的 CREATE TABLE / CREATE INDEX 都是 IF NOT EXISTS，可以重复跑。
--   （迁移前的 access_logs 只有 id / user_id / ua / created_at 四列。）
--
-- 新装库不需要本文件：schema.sql 已经是迁移后的最新结构（`npm run db:init:local` / `db:init:remote`）。
-- ============================================================================

-- 客户端 IP 与地理信息（Cloudflare 的 CF-Connecting-IP 与 request.cf）
ALTER TABLE access_logs ADD COLUMN ip TEXT;
ALTER TABLE access_logs ADD COLUMN country TEXT;
ALTER TABLE access_logs ADD COLUMN region TEXT;
ALTER TABLE access_logs ADD COLUMN city TEXT;

-- 客户端自报的环境快照（JSON，≤2000 字符；形状见 functions/_lib/clientEnv.ts）
ALTER TABLE access_logs ADD COLUMN env TEXT;

-- 爬虫判定：bot 在 SQLite 里用 0/1；默认 0，保证既有历史行（迁移前的记录）都是"未判定为爬虫"
ALTER TABLE access_logs ADD COLUMN bot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE access_logs ADD COLUMN bot_reason TEXT;

-- 游玩日志：与 schema.sql 中的定义保持逐字一致（迁移文件不引用 schema.sql，故两边都要改）
CREATE TABLE IF NOT EXISTS play_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  mode       TEXT    NOT NULL,
  source     TEXT    NOT NULL,
  ua         TEXT,
  ip         TEXT,
  country    TEXT,
  region     TEXT,
  city       TEXT,
  env        TEXT,
  bot        INTEGER NOT NULL DEFAULT 0,
  bot_reason TEXT,
  created_at INTEGER NOT NULL
);

-- 索引：看板按 created_at 做范围分桶，明细按 id 倒序分页；mode 索引给"按模式看游玩量"留的口子
CREATE INDEX IF NOT EXISTS idx_access_logs_created ON access_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_logs_created ON play_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_logs_mode ON play_logs(mode, created_at DESC);
