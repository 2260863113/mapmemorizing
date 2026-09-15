/**
 * 「国名 / 首都」「中文 / 英文」「省名 / 简称」的本地记忆（localStorage）。
 *
 * 与 `granularityStore.ts` 同一手法：一个模式的键前缀 + 非法值逐字段回落默认。
 * 为什么逐字段回落（而不是整体回落）：三个开关互不相关，一个字段被写坏不该把另外两个一起重置。
 */
import type { QuestionNaming } from './types';

/** 存储键前缀。各模式用自己的后缀（'self' / 'click'），互不干扰。 */
const KEY_PREFIX = 'china-admin-mode-naming:';

/** 首访默认：国名 + 中文 + 省名 —— 即本功能上线前的历史行为，老用户升上来观感不变。 */
export const DEFAULT_NAMING: QuestionNaming = { world: 'country', lang: 'zh', province: 'full' };

export function namingStorageKey(modePrefix: string): string {
  return KEY_PREFIX + modePrefix;
}

/** 读取名口径记忆。存储不可用（隐私模式 / 配额）或 JSON 损坏时回落默认。 */
export function loadStoredNaming(modePrefix: string): QuestionNaming {
  try {
    const raw = localStorage.getItem(namingStorageKey(modePrefix));
    if (!raw) return { ...DEFAULT_NAMING };
    const parsed = JSON.parse(raw) as Partial<QuestionNaming>;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_NAMING };
    return {
      world: parsed.world === 'capital' ? 'capital' : parsed.world === 'flag' ? 'flag' : DEFAULT_NAMING.world,
      lang: parsed.lang === 'en' ? 'en' : DEFAULT_NAMING.lang,
      province: parsed.province === 'abbr' ? 'abbr' : DEFAULT_NAMING.province,
    };
  } catch {
    return { ...DEFAULT_NAMING };
  }
}

/** 写取名口径记忆。存储失败静默忽略 —— 不该因为存不下而影响答题。 */
export function saveStoredNaming(modePrefix: string, naming: QuestionNaming): void {
  try {
    localStorage.setItem(namingStorageKey(modePrefix), JSON.stringify(naming));
  } catch {
    /* 忽略存储失败 */
  }
}
