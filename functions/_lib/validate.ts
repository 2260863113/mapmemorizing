/** 入参校验与纯函数规则（与前端 authStore/leaderboardStore 对齐）。 */

import { ApiError } from './http';

export interface PasswordHashPayload {
  algorithm: string;
  salt: string;
  hash: string;
  iterations: number;
}

export type ScoreMode = 'self' | 'click' | 'endless' | 'puzzle';

/** 省级全国哨兵：区别于市级全国（null/''）与某省地级榜（6 位 adcode）。与前端 province.ts 保持一致。 */
export const PROVINCE_NATION_SCOPE = '__province_nation__';
/** 世界全国哨兵：独立作用域行（区别于市级全国 null/'' 与省级全国哨兵）。与前端 province.ts 保持一致。 */
export const WORLD_NATION_SCOPE = '__world_nation__';
/**
 * 大洲榜哨兵前缀/后缀：__continent_<AS|EU|AF|NA|SA|OC>__（各大洲榜独立，熟练度共享）。
 * 与前端 province.ts 保持一致。
 */
export const CONTINENT_SCOPE_PREFIX = '__continent_';
export const CONTINENT_IDS = ['AS', 'EU', 'AF', 'NA', 'SA', 'OC'] as const;

/**
 * 次区域榜哨兵前缀/后缀：__subregion_<EAS|…>__（各次区域榜独立，熟练度共享）。
 * 与前端 province.ts / src/types.ts 的 SUBREGION_IDS 保持一致。
 *
 * ⚠️ 这些字符串会永久写进 D1（leaderboard 表的 scope_province 列）。
 * 按 docs/adr/0001 的原则：一旦上线就不能再改，否则历史成绩变孤儿。
 * 新增次区域时**前端的 SUBREGION_IDS 与此处必须同步**，且 subregions.json 要重建。
 */
export const SUBREGION_SCOPE_PREFIX = '__subregion_';
export const SUBREGION_IDS = [
  'EAS', 'SEA', 'SAS', 'WAS', 'CAS',
  'NEU', 'WEU', 'CEU', 'EEU', 'SEU',
  'NAF', 'WAF', 'MAF', 'EAF', 'SAF',
  'NAM', 'CAM', 'CAR',
  'SAM',
  'ANZ', 'MEL', 'MIC', 'POL',
] as const;

/** 是否为合法的大洲榜哨兵（如 __continent_AS__）。 */
export function isContinentScope(scope: string | null | undefined): boolean {
  if (typeof scope !== 'string' || !scope.startsWith(CONTINENT_SCOPE_PREFIX) || !scope.endsWith('__')) return false;
  const id = scope.slice(CONTINENT_SCOPE_PREFIX.length, -2);
  return (CONTINENT_IDS as readonly string[]).includes(id);
}

/** 是否为合法的次区域榜哨兵（如 __subregion_EAS__）。 */
export function isSubregionScope(scope: string | null | undefined): boolean {
  if (typeof scope !== 'string' || !scope.startsWith(SUBREGION_SCOPE_PREFIX) || !scope.endsWith('__')) return false;
  const id = scope.slice(SUBREGION_SCOPE_PREFIX.length, -2);
  return (SUBREGION_IDS as readonly string[]).includes(id);
}

/** 是否为任意「世界范围」榜哨兵（世界全国 / 大洲 / 次区域）。 */
export function isWorldScope(scope: string | null | undefined): boolean {
  return scope === WORLD_NATION_SCOPE || isContinentScope(scope) || isSubregionScope(scope);
}

/** 用户名归一化：与前端 cleanUsername 一致（trim、压缩空白、截 24）。 */
export function cleanUsername(username: unknown): string {
  return typeof username === 'string'
    ? username.trim().replace(/\s+/g, ' ').slice(0, 24)
    : '';
}

/** 校验前端传来的 PBKDF2 哈希结构。 */
export function normalizePasswordHash(value: unknown): PasswordHashPayload {
  if (!value || typeof value !== 'object') throw new ApiError(400, 'invalid_password_hash', '密码哈希格式错误');
  const row = value as Partial<PasswordHashPayload>;
  if (row.algorithm !== 'PBKDF2-SHA-256') throw new ApiError(400, 'invalid_password_hash', '不支持的密码算法');
  if (typeof row.salt !== 'string' || typeof row.hash !== 'string') throw new ApiError(400, 'invalid_password_hash', '密码哈希格式错误');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(row.salt) || !/^[A-Za-z0-9+/]+={0,2}$/.test(row.hash)) {
    throw new ApiError(400, 'invalid_password_hash', '密码哈希格式错误');
  }
  const iterations = typeof row.iterations === 'number' && Number.isInteger(row.iterations) ? row.iterations : 0;
  if (iterations < 120000) throw new ApiError(400, 'invalid_password_hash', '密码迭代次数过低');
  return { algorithm: row.algorithm, salt: row.salt, hash: row.hash, iterations };
}

const MODES = new Set(['self', 'click', 'endless', 'puzzle']);

/**
 * 拼图榜接受**所有合法范围**（与前端 `isPuzzleLeaderboardScope` 一致，2026-09-16 扩大口径）：
 * 市级全国（''）、省级全国、世界全国、大洲、次区域、单省（6 位 adcode）各自独立成行。
 *
 * scope 本身的合法性已经由 `normalizeScope()`（下面的白名单）把关，这里不再另开一份名单 ——
 * 两份手写的名单一旦漂移就会出现"前端能交、后端拒绝"的静默失败（旧实现正是这么写的）。
 */

/** 拼图成绩的下限：至少吸上过一片（前端「已拼」口径 = 1 + 吸附次数，故 ≥ 2）。 */
export const PUZZLE_MIN_SUBMIT = 2;

export function validMode(mode: unknown): mode is ScoreMode {
  return typeof mode === 'string' && MODES.has(mode);
}

export interface ScorePayload {
  mode: ScoreMode;
  scopeProvince: string | null;
  scopeLabel: string;
  totalUnits: number;
  correct: number;
  wrong: number;
  elapsedMs: number;
  finishedAt: number;
  coins?: number;
  level?: number;
}

/**
 * scope 白名单：''（市级全国）、省级全国哨兵、世界全国哨兵、大洲榜哨兵、次区域榜哨兵、
 * 6 位 adcode（单省）。拒绝任意非空字符串污染省级榜。
 *
 * 返回归一化后的 scope 而不是只做断言：`asserts` 谓词在调用点收窄跨函数引用不稳，
 * 返回值的写法让调用方直接拿到 `string | null`。
 */
function normalizeScope(scopeProvince: unknown): string | null {
  // 类型守卫：拒绝 undefined 与非字符串
  if (scopeProvince !== null && typeof scopeProvince !== 'string') throw new ApiError(400, 'invalid_scope', '无效的范围');
  if (
    typeof scopeProvince === 'string' &&
    scopeProvince !== '' &&
    scopeProvince !== PROVINCE_NATION_SCOPE &&
    scopeProvince !== WORLD_NATION_SCOPE &&
    !isContinentScope(scopeProvince) &&
    !isSubregionScope(scopeProvince) &&
    !/^\d{6}$/.test(scopeProvince)
  ) {
    throw new ApiError(400, 'invalid_scope', '无效的范围');
  }
  return scopeProvince;
}

/** 五个数值字段必须是有限非负数（挡住 NaN / Infinity / 字符串注入），并归一化成整数。 */
function readScoreNumbers(row: Partial<ScorePayload>) {
  const totalUnits = Number(row.totalUnits);
  const correct = Number(row.correct);
  const wrong = Number(row.wrong);
  const elapsedMs = Number(row.elapsedMs);
  const finishedAt = Number(row.finishedAt);
  if (!Number.isFinite(totalUnits) || totalUnits < 0) throw new ApiError(400, 'invalid_score', '无效的题目总数');
  if (!Number.isFinite(correct) || correct < 0) throw new ApiError(400, 'invalid_score', '无效的答对数');
  if (!Number.isFinite(wrong) || wrong < 0) throw new ApiError(400, 'invalid_score', '无效的答错数');
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new ApiError(400, 'invalid_score', '无效的用时');
  if (!Number.isFinite(finishedAt)) throw new ApiError(400, 'invalid_score', '无效的提交时间');
  return {
    totalUnits: Math.floor(totalUnits),
    correct: Math.floor(correct),
    wrong: Math.floor(wrong),
    elapsedMs: Math.round(elapsedMs),
    finishedAt: Math.floor(finishedAt),
  };
}

/**
 * 提交资格（复刻前端 canSubmitScore，两侧语义必须逐条一致）：
 *   ·无尽的 endless 需有金币（不统计题数，totalUnits 恒 0），通过时就地补 coins/level；
 *   ·拼图**所有合法范围**都可提交，且「已拼」≥2、不得超过总片数、没有答错；
 *   ·self/click 的**所有**范围（市级全国 null、省级全国哨兵、世界全国、大洲、次区域、单省 adcode）
 *     共用同一条门槛：至少答过一题（correct + wrong > 0），且 totalUnits > 0、correct <= totalUnits。
 *
 * 为什么省级榜也不再要求「全对/答完」：榜单排序已经是「先比答对个数、再比用时」，
 * 答得少的名次自然靠后，再在入口卡全对只会让「全国榜能交、省级榜交不了」这种自相矛盾的口径出现。
 */
function assertSubmittable(payload: ScorePayload, row: Partial<ScorePayload>): void {
  if (payload.mode === 'endless') {
    const coins = Number(row.coins);
    if (!Number.isFinite(coins) || coins <= 0) throw new ApiError(400, 'invalid_score', '尚未收集金币');
    payload.coins = Math.floor(coins);
    const level = Number(row.level);
    payload.level = Number.isFinite(level) && level >= 1 ? Math.floor(level) : 1;
    return;
  }
  if (payload.mode === 'puzzle') {
    // 范围合法性已由 normalizeScope() 把关（所有合法范围都可提交拼图成绩）
    if (payload.totalUnits < PUZZLE_MIN_SUBMIT) throw new ApiError(400, 'invalid_score', '无效的总片数');
    if (payload.wrong !== 0) throw new ApiError(400, 'invalid_score', '拼图成绩不含答错数');
    if (payload.correct < PUZZLE_MIN_SUBMIT || payload.correct > payload.totalUnits) {
      throw new ApiError(400, 'invalid_score', '至少吸上拼成一片才能提交成绩');
    }
    return;
  }
  if (payload.totalUnits <= 0) throw new ApiError(400, 'invalid_score', '无效的题目总数');
  if (payload.correct > payload.totalUnits) throw new ApiError(400, 'invalid_score', '无效的答对数');
  // 所有范围同一门槛：答过题即可上榜（不强制全对、不强制答完）。0 题属于没答，不足以成成绩。
  if (payload.correct + payload.wrong <= 0) throw new ApiError(400, 'invalid_score', '至少回答一题才能提交成绩');
}

/** 校验提交的成绩。三段式：scope 白名单 → 数值守卫 → 提交资格（各自成函数）。 */
export function validateScore(body: unknown): ScorePayload {
  if (!body || typeof body !== 'object') throw new ApiError(400, 'invalid_score', '成绩格式错误');
  const row = body as Partial<ScorePayload>;
  if (!validMode(row.mode)) throw new ApiError(400, 'invalid_mode', '无效的模式');
  const scope = normalizeScope(row.scopeProvince);
  if (typeof row.scopeLabel !== 'string' || !row.scopeLabel.trim()) throw new ApiError(400, 'invalid_scope_label', '缺少范围名称');

  const nums = readScoreNumbers(row);
  const now = Date.now();
  if (Math.abs(nums.finishedAt - now) > 5 * 60 * 1000) throw new ApiError(400, 'stale_result', '成绩已过期，请重新作答');

  const payload: ScorePayload = {
    mode: row.mode,
    // '' 是「市级全国」的哨兵，对外统一成 null
    scopeProvince: scope === '' ? null : scope,
    scopeLabel: row.scopeLabel.trim(),
    ...nums,
  };
  assertSubmittable(payload, row);
  return payload;
}

/**
 * 为什么这里不再有 `isNationScope()`：旧实现用它区分「全国语义（答对题数优先）」与
 * 「省级语义（仅比用时）」，本轮口径统一后**除 endless 外一律 correct 优先**，
 * 该判定已无任何调用点（`score.ts` 的 upsert 分支与 `leaderboard.ts` 的 orderBy 同样统一），
 * 保留一个永远为真的分支只会让后来者误以为还存在两套排序。世界范围的判定仍然可用 `isWorldScope()`。
 */

/**
 * 新成绩是否比已有成绩更优（与前端及数据库排序共用同一条口径）。
 *
 * 除 endless（比金币 → 比关卡）外**一律「correct 降序、同数比用时升序」** ——
 * 必须与 `leaderboard.ts` 的 orderBy、`score.ts` 的 ON CONFLICT ... WHERE 完全一致，
 * 否则会出现「榜上按 correct 排序、但更优判断只比用时」的自相矛盾：
 * 例如 5 题的旧成绩用时更短时，10 题的新成绩会被判「不如旧成绩」而被丢弃。
 */
export function isBetter(next: ScorePayload, existing: { coins: number | null; level: number | null; correct: number; elapsed_ms: number }): boolean {
  if (next.mode === 'endless') {
    const nextCoins = next.coins ?? 0;
    const existingCoins = existing.coins ?? 0;
    return nextCoins > existingCoins || (nextCoins === existingCoins && (next.level ?? 1) > (existing.level ?? 1));
  }
  // 拼图的 correct 列存「已拼个数」，走的正是同一条「个数优先、同数比用时」规则。
  return next.correct > existing.correct || (next.correct === existing.correct && next.elapsedMs < existing.elapsed_ms);
}
