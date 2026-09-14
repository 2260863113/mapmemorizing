/**
 * 家乡（省 / 市）文本解析：把用户输入的省名、市名文本解析成持久化用的 adcode 对。
 *
 * 为什么单独成模块：这套逻辑原先长在 `authPanel.ts` 里（面板类 619 行的 1/4），
 * 但它**完全不碰 DOM** —— 是「用户输入的'广东'到底对应哪个 adcode」的领域规则，
 * 而解析结果会写进 D1、再显示在排行榜上（写错就永久错）。
 * 抽成纯函数后可以脱离浏览器单测，见 `hometown.test.ts`。
 *
 * 口径（与抽取前逐字一致，不改行为）：
 *   · 省名按 `normalizeProvince`（剥省级后缀）**精确**匹配，不做模糊；
 *   · 市名按 `normalize`（剥民族词 + 行政后缀）全名或简称**精确**匹配；
 *   · 省与市必须同时填写或同时留空（只填省 = `invalidCity`）。
 */
import { normalize, normalizeProvince } from '../matcher';
import type { AppData, Province, Unit, UserHometown } from '../types';

/** 装饰面 adcode（南海诸岛等）：不是真实地级单位，不参与市名匹配。 */
const DECORATIVE_ADCODE = '100000_JD';

/**
 * 文本匹配分（100 全等 / 80 前缀 / 60 包含 / 0 不匹配）。
 *
 * 只用于**候选排序**（下拉前 8~10 条），不用于定值 —— 定值走 `matchProvince` / `matchCity`，
 * 避免「先写广东再写广州」这类输入被模糊匹配悄悄解析成别的城市。
 */
export function scoreText(input: string, value: string): number {
  if (input === value) return 100;
  if (value.startsWith(input)) return 80;
  if (input.length >= 2 && value.includes(input)) return 60;
  return 0;
}

/** 省级文本 → 候选省列表（按匹配分降序；空输入 = 全部省，保持数据顺序）。 */
export function rankProvinces(data: AppData, input: string): Province[] {
  const ni = normalizeProvince(input);
  const rows = [...data.provinces];
  if (!ni) return rows;
  return rows
    .map((province) => ({ province, score: scoreText(ni, normalizeProvince(province.name)) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.province);
}

/** 该省的地级单位行（装饰面除外）。 */
export function cityRows(data: AppData, provinceAdcode: string): Unit[] {
  return data.allUnits.filter((unit) => unit.provinceAdcode === provinceAdcode && unit.adcode !== DECORATIVE_ADCODE);
}

/** 市级文本 → 候选市列表（限该省；空输入 = 该省全部市）。 */
export function rankCities(data: AppData, provinceAdcode: string, input: string): Unit[] {
  const rows = cityRows(data, provinceAdcode);
  const ni = normalize(input);
  if (!ni) return rows;
  return rows
    .map((city) => ({ city, score: Math.max(scoreText(ni, normalize(city.name)), scoreText(ni, city.shortName)) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.city);
}

export function provinceByAdcode(data: AppData, adcode: string): Province | null {
  return data.provinces.find((province) => province.adcode === adcode) ?? null;
}

export function cityByAdcode(data: AppData, adcode: string): Unit | null {
  return data.allUnits.find((unit) => unit.adcode === adcode && unit.adcode !== DECORATIVE_ADCODE) ?? null;
}

/** 省名精确匹配（空输入一律 null）。 */
export function matchProvince(data: AppData, input: string): Province | null {
  const ni = normalizeProvince(input);
  if (!ni) return null;
  return data.provinces.find((province) => normalizeProvince(province.name) === ni) ?? null;
}

/** 市名精确匹配（限该省；全名或简称命中即可）。 */
export function matchCity(data: AppData, provinceAdcode: string, input: string): Unit | null {
  const ni = normalize(input);
  if (!ni) return null;
  return cityRows(data, provinceAdcode).find((city) => normalize(city.name) === ni || city.shortName === ni) ?? null;
}

/**
 * 解析结果。用可辨识联合而不是 `Error` 实例：
 * 调用方（面板）要按**类别**选 i18n 文案，测试也只需要断言类别。
 */
export type HometownResolution =
  | { status: 'empty' }
  | { status: 'invalidProvince' }
  | { status: 'invalidCity' }
  | { status: 'ok'; hometown: UserHometown };

/**
 * 解析「省 + 市」两个文本输入。
 *
 * 返回 `empty` 表示两项都留空（合法：用户就是不填家乡，此时面板不该清掉已有状态）；
 * `invalidProvince` / `invalidCity` 表示文本与数据对不上；`ok` 才给出可持久化的 adcode 对。
 */
export function resolveHometown(data: AppData, provinceText: string, cityText: string): HometownResolution {
  if (!provinceText && !cityText) return { status: 'empty' };
  const province = matchProvince(data, provinceText);
  if (!province) return { status: 'invalidProvince' };
  const city = matchCity(data, province.adcode, cityText);
  if (!city || city.provinceAdcode !== province.adcode) return { status: 'invalidCity' };
  return { status: 'ok', hometown: { provinceAdcode: province.adcode, cityAdcode: city.adcode } };
}
