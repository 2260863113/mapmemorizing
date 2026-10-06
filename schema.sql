-- 云端共享排行榜：D1 数据库结构
-- 密码方案：浏览器端 PBKDF2-SHA-256（120000 迭代、随机 16B salt），这里只存哈希结果（明文不出浏览器）。

-- 账号表
CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_salt       TEXT    NOT NULL,              -- base64(16B)
  password_hash       TEXT    NOT NULL,              -- base64(32B)
  password_iterations INTEGER NOT NULL DEFAULT 120000,
  hometown            TEXT,                          -- JSON 或 NULL {provinceAdcode,cityAdcode}
  avatar              TEXT,                          -- JSON 或 NULL {dataUrl,name,size,type}（dataUrl≤20KB）
  is_admin            INTEGER NOT NULL DEFAULT 0,    -- 1 = 管理员
  created_at          INTEGER NOT NULL,              -- epoch ms
  updated_at          INTEGER NOT NULL
);

-- 会话表：token 明文只发给前端，库中只存 SHA-256 摘要
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 排行榜表
-- scope_province: '' = 全国榜，6 位 adcode = 省级榜。
-- 用 '' 而非 NULL：SQLite 的 UNIQUE 约束把 NULL 视为互不相同，NULL 会导致全国榜每人多条。
-- UNIQUE(user_id, mode, scope_province) 支撑 upsert：每 (用户,模式,范围) 仅保留一条最优。
CREATE TABLE IF NOT EXISTS leaderboard (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  mode           TEXT    NOT NULL,                  -- 'self' | 'click' | 'endless' | 'puzzle'
  scope_province TEXT    NOT NULL DEFAULT '',
  scope_label    TEXT    NOT NULL,
  total_units    INTEGER NOT NULL,                  -- 拼图：本范围总片数
  correct        INTEGER NOT NULL,                  -- 拼图：已拼个数（1 + 吸附次数）
  elapsed_ms     INTEGER NOT NULL,
  coins          INTEGER,                            -- endless 累计金币
  level          INTEGER,                            -- endless 到达关卡
  submitted_at   INTEGER NOT NULL,
  UNIQUE(user_id, mode, scope_province)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_lookup ON leaderboard(mode, scope_province);

-- 留言板
-- 帖子表：用户可发帖（登录），删除自己的帖子时级联删除其回复
CREATE TABLE IF NOT EXISTS board_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  content    TEXT    NOT NULL,              -- 纯文本，≤200 字
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_posts_created ON board_posts(created_at DESC);

-- 回复表：针对某帖子的从属内容（登录），≤100 字
CREATE TABLE IF NOT EXISTS board_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  content    TEXT    NOT NULL,              -- 纯文本，≤100 字
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_replies_post ON board_replies(post_id, created_at);

-- 公告表：标题 + 正文（纯文本），pinned=1 置顶（站点介绍）
CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 访问日志表：每次页面访问一条，user_id 可为 NULL（匿名访问；是游客还是爬虫由 bot 判定区分）
-- 环境快照（env）与判定理由（bot_reason）都存 JSON 字符串：管理端只展示，不参与查询，
-- 拆成列反而会让「以后要加一个环境字段」变成一次迁移。
CREATE TABLE IF NOT EXISTS access_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,                               -- NULL = 未登录
  ua         TEXT,                                  -- 完整 User-Agent（不截断）
  ip         TEXT,                                  -- CF-Connecting-IP
  country    TEXT,                                  -- request.cf.country（ISO 3166-1 alpha-2）
  region     TEXT,                                  -- request.cf.region
  city       TEXT,                                  -- request.cf.city
  env        TEXT,                                  -- 客户端环境快照 JSON（≤2000 字符，见 functions/_lib/clientEnv.ts）
  bot        INTEGER NOT NULL DEFAULT 0,             -- 1 = 疑似爬虫/自动化
  bot_reason TEXT,                                  -- 判定理由 JSON 数组字符串，如 ["overseas","keyword:headless"]
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_logs_created ON access_logs(created_at DESC);

-- 游玩日志表：每次「开始一局」一条（点「开始」或按 Tab 快速重置），供管理端「游玩统计」。
-- 与 access_logs 分开：访问次数与开始局数是两个口径，混一张表后任一侧加字段都会污染另一侧。
-- 客户端环境同样记一份：管理员要能从游玩记录里判断"这些局是不是同一个人在刷"。
CREATE TABLE IF NOT EXISTS play_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,                               -- NULL = 未登录
  mode       TEXT    NOT NULL,                      -- 'self' | 'click' | 'endless' | 'puzzle'
  source     TEXT    NOT NULL,                      -- 'start' | 'tab'（Tab 快速重置也要计入统计）
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
CREATE INDEX IF NOT EXISTS idx_play_logs_created ON play_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_logs_mode ON play_logs(mode, created_at DESC);
