/**
 * 把 `migrations/*.sql` 按文件名顺序**全部**应用到 D1（本地或线上）。
 *
 * ## 为什么需要它，而不是在 package.json 里写死两个 wrangler 命令
 *
 * 1. **SQLite 的 `ALTER TABLE` 没有 `ADD COLUMN IF NOT EXISTS`** —— 重复执行会报
 *    `duplicate column name: xxx`。这在语义上不是失败（说明这条已经迁过了），但会让
 *    `cmd` 里的 `&&` 链**中断**，于是"跑一遍就到位"变成"跑第二遍才到位"，最容易在上线时踩。
 *    本脚本把 `duplicate column` 识别为"已迁移"并继续跑后面的文件。
 * 2. 迁移文件会越来越多，写死文件名意味着每加一条就要改 package.json，改漏一次的表现是
 *    **线上少一列、且不报错**（上报路径对写库失败只 console.warn）。
 *
 * ## 用法
 *
 *   node scripts/db-migrate.mjs --local     # 本地 dev 库（.wrangler/state）
 *   node scripts/db-migrate.mjs --remote    # 线上库（会真的改数据）
 *
 * 等价于 `npm run db:migrate:local` / `npm run db:migrate:remote`。
 * 新装库不需要它：`schema.sql` 已是最新结构（`npm run db:init:local|remote`）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 库名与 wrangler.toml 的 `database_name` 一致（既有 npm 脚本同样写死它）。 */
const DATABASE = 'china-admin-memory-db';
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const local = args.includes('--local');
if (remote === local) {
  console.error('用法：node scripts/db-migrate.mjs --local | --remote（必须且只能选一个）');
  process.exit(2);
}
if (!fs.existsSync(WRANGLER)) {
  console.error(`找不到 wrangler：${WRANGLER}（先跑 npm install）`);
  process.exit(2);
}

const files = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort(); // 文件名带日期前缀，字典序即时间序

if (!files.length) {
  console.log('没有迁移文件，什么都不用做');
  process.exit(0);
}

console.log(`目标：${remote ? '线上库 --remote（会改数据）' : '本地库 --local'}，共 ${files.length} 个迁移文件`);
const target = remote ? '--remote' : '--local';
let applied = 0;
let skipped = 0;

for (const file of files) {
  const full = path.join(MIGRATIONS_DIR, file);
  const r = spawnSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', DATABASE, target, `--file=${full}`],
    { encoding: 'utf8', cwd: ROOT },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status === 0) {
    applied += 1;
    console.log(`✓ ${file} 已应用`);
    continue;
  }
  // 已迁移过的信号：ALREADY_APPLIED 不是失败，继续跑后面的文件（见文件头第 1 条）
  if (/duplicate column name/i.test(out)) {
    skipped += 1;
    console.log(`• ${file} 已迁移过（duplicate column），跳过`);
    continue;
  }
  console.error(`✗ ${file} 失败：\n${out.trim()}`);
  process.exit(1);
}

console.log(`完成：应用 ${applied} 个、跳过 ${skipped} 个（跳过的说明该库已有这些列）`);
