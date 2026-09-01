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
  mode           TEXT    NOT NULL,                  -- 'self' | 'click' | 'endless'
  scope_province TEXT    NOT NULL DEFAULT '',
  scope_label    TEXT    NOT NULL,
  total_units    INTEGER NOT NULL,
  correct        INTEGER NOT NULL,
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
