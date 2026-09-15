export type Mode = 'free' | 'self' | 'endless' | 'click' | 'board' | 'admin' | 'puzzle';
export type UnitColor =
  | 'green'
  | 'blue'
  | 'red'
  | 'gray'
  | 'scoreGreenLight'
  | 'scoreGreenMedium'
  | 'scoreGreenDark'
  | 'scoreRedLight'
  | 'scoreRedMedium'
  | 'scoreRedDark';

export interface Unit {
  adcode: string;
  name: string; // 官方全名（地图单位）或短名（北京/上海等整体单位）
  shortName: string; // 去限定词后的简称，如「黔南」
  province: string; // 所属省全名
  provinceAdcode: string;
  center: [number, number];
  neighbors: string[]; // 相邻单位 adcode 列表
  decorative?: boolean; // 南海诸岛等装饰性面，不参与匹配/统计/测试
}

export interface Province {
  adcode: string;
  name: string;
  center: [number, number];
}

/** 大洲 id（世界粒度下钻范围；countries.json 的 continent 字段）。 */
export type Continent = 'AS' | 'EU' | 'AF' | 'NA' | 'SA' | 'OC';

/** 大洲元数据（顺序即 UI 展示顺序）。 */
export const CONTINENTS: readonly { id: Continent; name: string; short: string }[] = [
  { id: 'AS', name: '亚洲', short: '亚洲' },
  { id: 'EU', name: '欧洲', short: '欧洲' },
  { id: 'AF', name: '非洲', short: '非洲' },
  { id: 'NA', name: '北美洲', short: '北美' },
  { id: 'SA', name: '南美洲', short: '南美' },
  { id: 'OC', name: '大洋洲', short: '大洋洲' },
] as const;

/**
 * 次区域 id（世界粒度第二层下钻范围；subregions.json 的 subregions[].id）。
 * 元数据与 iso → 次区域映射同源于 public/data/subregions.json（见 scripts/build-subregions.mjs）。
 */
export type SubregionId =
  | 'EAS' | 'SEA' | 'SAS' | 'WAS' | 'CAS'
  | 'NEU' | 'WEU' | 'CEU' | 'EEU' | 'SEU'
  | 'NAF' | 'WAF' | 'MAF' | 'EAF' | 'SAF'
  | 'NAM' | 'CAM' | 'CAR'
  | 'SAM'
  | 'ANZ' | 'MEL' | 'MIC' | 'POL';

/**
 * 次区域 id 全集（运行期数组，用于 scope 哨兵白名单校验）。
 * 与 SubregionId 联合类型**必须同步**：新增次区域时两处都要加，且 subregions.json 也要重建。
 * 与 public/data/subregions.json 的 subregions[].id 逐字一致（由 scripts/check-subregions 断言）。
 */
export const SUBREGION_IDS: readonly SubregionId[] = [
  'EAS', 'SEA', 'SAS', 'WAS', 'CAS',
  'NEU', 'WEU', 'CEU', 'EEU', 'SEU',
  'NAF', 'WAF', 'MAF', 'EAF', 'SAF',
  'NAM', 'CAM', 'CAR',
  'SAM',
  'ANZ', 'MEL', 'MIC', 'POL',
] as const;

/** 世界“国家”元数据（public/data/countries.json 生成；iso_a3 为答题 id）。 */
export interface CountryMeta {
  iso: string;
  name: string; // 中文简称（题面与判题基准，如 中国）
  fullName: string; // 官方全称（容错输入与展示）
  center: [number, number];
  neighbors: string[]; // 相邻国家 iso 列表
  continent: Continent; // 所属大洲（世界粒度下钻范围）
}

/**
 * 国家的英文名与首都名（public/data/world_names.json 生成，来源 Natural Earth v5.1.2，公有领域）。
 *
 * 为什么与 countries.json 分开成一张表：countries.json 由世界几何管线产出，那条管线的输出契约
 * 被 lib 与探针逐字依赖（见 scripts/fetch-world-data-v2.mjs 顶部「一行不改」的口径）；
 * 语言/首都属于**另一类事实**（与几何无关、可单独重建），故单独一张表，key 同为 iso_a3。
 */
export interface CountryNames {
  en: string; // 英文常用名（题面与标签的英文口径，如 Japan）
  capital: string; // 首都中文名（如 东京）
  capitalEn: string; // 首都英文名（如 Tokyo）
}

export type BoundaryTone = 'light' | 'mid' | 'dark';

export interface AppData {
  units: Unit[]; // 真实记忆单位（不含装饰）
  allUnits: Unit[]; // 含装饰（南海诸岛等纯装饰面）
  provinces: Province[];
  geoJson: unknown; // 地级（fine 档 15%，6 ≤ zoom < 10 / 宽省钻取）
  coarseGeoJson: unknown; // 地级（coarse 历史别名 = pro 8%，保留字段兼容旧数据）
  ultraGeoJson: unknown; // 地级（ultra 档 4%，zoom < 2，最简略）
  proGeoJson: unknown; // 地级（pro 档 8%，2 ≤ zoom < 6）
  plusGeoJson: unknown; // 地级（plus 档 40%，10 ≤ zoom < 14）
  losslessGeoJson: unknown; // 地级（无损档 100%，zoom ≥ 14；靠视口裁剪提速）
  provincesGeoJson: unknown; // 省界图层（fine 15%，6 ≤ zoom < 10）
  provincesCoarseGeoJson: unknown; // 省界图层（coarse 历史别名 = ultra 4%，兼容旧数据）
  provincesUltraGeoJson: unknown; // 省界图层（ultra 4%，zoom < 2）
  provincesProGeoJson: unknown; // 省界图层（pro 8%，2 ≤ zoom < 6）
  provincesPlusGeoJson: unknown; // 省界图层（plus 40%，10 ≤ zoom < 14）
  provincesRawGeoJson: unknown; // 省界图层（无损档 100%，zoom ≥ 14）
  hkmacGeoJson: unknown; // 港澳放大框无压缩面（广东+香港+澳门，始终最精细不简化）
  countries: CountryMeta[]; // 世界答题国（194 国，见 docs/adr/0005）
  /** iso_a3 → 英文名 / 首都名（world_names.json；「国名 / 首都」与「中文 / 英文」分段按钮用）。 */
  countryNames: Record<string, CountryNames>;
  /**
   * iso_a3 → 国旗文件名（public/data/flags/index.json；点击模式「国旗」档的题面用）。
   * 值是 `public/data/flags/` 下的文件名（如 `jp.svg`），前端拼成 `data/flags/<文件名>` 加载。
   */
  countryFlags: Record<string, string>;
  /**
   * iso_a3 → 国旗**缩略图**文件名（public/data/flags/thumbs.json；未开始浏览标签上的国旗用）。
   *
   * 与 `countryFlags` 是两张表、单一职责：那张是原始矢量（题面卡片要清楚、且用户口径明确不压缩），
   * 这张是 40×30 WebP 小图（地图标签只有二十几像素宽，194 张合计 163KB 而原始 SVG 是 1.21MB）。
   * 同样拼成 `data/flags/thumbs/<文件名>`。两张表的键集合一致由 `worldFlagsData.test.ts` 断言。
   */
  countryFlagThumbs: Record<string, string>;
  worldGeoJson: unknown; // 世界地图（答题国 + 装饰面）
  subregions: SubregionMeta[]; // 世界 23 个次区域（方位式粗分，见 docs/adr/0004）
  isoSubregion: Record<string, SubregionId>; // iso_a3 → 次区域 id（194 条全覆盖）
  /** iso_a3 → 国面面积（度²，构建期算好）：供「自动跟随缩放与国家面积成反比」与「极小国家」判定用。 */
  countryArea: Record<string, number>;
}

/** 次区域元数据（public/data/subregions.json 生成）。 */
export interface SubregionMeta {
  id: SubregionId;
  name: string; // 中文名（如 东亚）
  continent: Continent; // 所属大洲（次区域 ⊆ 大洲，由构建期断言保证）
  count: number; // 该次区域内的答题国数量
}

export interface PracticeRecord {
  correctCount: number;
  wrongCount: number;
  score: number;
}

export interface MemoryRecord extends PracticeRecord {
  learned: boolean;
  firstLearnedAt: number;
  reviewCount: number;
  lastReviewAt: number;
}

export interface Settings {
  cityBoundaryTone: BoundaryTone;
  provinceBoundaryTone: BoundaryTone;
  /** 世界地图国家边界的深浅（与地级/省级边界同三档）。 */
  worldBoundaryTone: BoundaryTone;
  darkMode: boolean;
  /** 忽略面积极小的国家：不出题、不参与排行榜、地图上灰显且完全无交互。 */
  ignoreTinyCountries: boolean;
  /**
   * 下钻后隐藏无关地区（全局设置，2026-09，**默认开**）。
   *
   * - **开**（默认，与历史观感一致）：下钻到大洲 / 次区域 / 某省后，当前范围之外的面被画成透明，
   *   等于「看不见」。它们本来就不响应悬停、点击等同点空白（惰性面口径），只是连外观也不画。
   * - **关**：范围之外的面**保留可见**——填充为比地图空白底色更深一档的浅灰
   *   （`MapTheme.inactiveFill`），省界/国界照画，方便用户分辨"我在哪一块"；
   *   但它们**依旧不可交互**（不响应悬停与 tooltip、点击等同点空白、不参与判题与下钻）。
   *   同时下钻某省**不再强制最精细档**（lossless），仍按 zoom 走五档
   *   ——范围外的面也在画，必须走简化档才撑得住（见 `map/tiers.ts` 的 `drillForcesLossless`）。
   *
   * 两种取值只影响**渲染与档位**，不改变练习范围、出题池与排行榜。
   */
  hideUnrelatedOnDrill: boolean;
  /**
   * 未开始时显示地图标签（浏览态，2026-09）。
   *
   * 由已下线的「自由模式」并入：点击/输入/无尽闯关在**未开始**时显示全量地名（世界=国名、省级=省名、
   * 地级=地级市名），开始答题后隐藏、结束（结算/答完/重置）后恢复。开始/进行中的**已作答**绿红标签、
   * 熟练度分析的着色标签、拼图模式的难度口径都**不受**这个开关影响。
   */
  showBrowseLabels: boolean;
}

export interface RoundResult {
  mode: Extract<Mode, 'self' | 'click' | 'endless' | 'puzzle'>;
  scopeProvince: string | null;
  scopeLabel: string;
  totalUnits: number;
  /** 答对题数；**拼图模式**下是「已拼」个数（1 + 吸附次数）。 */
  correct: number;
  /** 答错题数；拼图模式下恒为 0（拼图没有"答错"）。 */
  wrong: number;
  elapsedMs: number;
  finishedAt: number;
  /** 无尽闯关：累计收集金币（排行榜按此排序） */
  coins?: number;
  /** 无尽闯关：到达的关卡 */
  level?: number;
}

export interface UserHometown {
  provinceAdcode: string;
  cityAdcode: string;
}

export interface UserAvatar {
  dataUrl: string;
  name: string;
  size: number;
  type: string;
}

export interface PasswordHash {
  algorithm: 'PBKDF2-SHA-256';
  salt: string;
  hash: string;
  iterations: number;
}

export interface AuthUser {
  username: string;
  password: PasswordHash;
  hometown: UserHometown | null;
  avatar: UserAvatar | null;
  createdAt: number;
  updatedAt: number;
}

/** 云端返回的公开用户信息（不含密码哈希）。 */
export interface UserProfile {
  username: string;
  hometown: UserHometown | null;
  avatar: UserAvatar | null;
  isAdmin: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 无尽闯关金币层：金币着色 + 中心标签（金币数或收集后的地名） */
export interface CoinLayer {
  coins: (adcode: string) => number; // 当前金币数（0 = 已收集 / 无金币）
  label: (adcode: string) => { text: string; price: boolean; noBg: boolean } | null; // 中心标签（price=价格，noBg=隐藏衬底，null = 不显示）
}

/** 省级练习省名标签：省级 adcode → 简称文本 + 对错配色 */
export interface ProvinceLabel {
  text: string;
  color: 'green' | 'red';
}

/**
 * **未开始的浏览标签**的内容（2026-09：地图标签按用户选的取名口径显示）。
 *
 * `text` = 文本标签（国名/首都/省名/省会/简称…）；`image` = 图片标签（「国旗」档的国旗小图）。
 * 两者互斥，`image` 优先。返回 `null`（或整个钩子不传）= 该单位没有口径特化内容，
 * 用系列默认文本（地级单位名 / 省去后缀名 / 国名）。
 */
export type BrowseLabelContent = { text?: string; image?: string };

export interface RenderState {
  colorOf: (adcode: string) => UnitColor;
  showAllLabels?: boolean; // 记忆模式：全部显示地名标签
  labelZoomThreshold?: number; // 地名标签显示倍率阈值
  disableTooltip?: boolean; // 记忆模式：关闭提示
  hideLabels?: boolean; // 隐藏全部地名标签（熟练度分析「隐藏地图标签」；优先于各 show*Labels 开关）
  coin?: CoinLayer; // 无尽闯关：金币绿色深浅着色 + 中心金币/地名标签
  provinceLabel?: (provinceAdcode: string) => ProvinceLabel | null; // 省级练习：已作答省的省名标签（null = 不显示）
  showAllProvinceLabels?: boolean; // 省级地图常显全部省名标签（熟练度分析省级档）
  worldLabel?: (iso: string) => ProvinceLabel | null; // 世界练习：已作答国家的国名标签（null = 不显示）
  worldShowAllLabels?: boolean; // 世界地图放大后常显全部国名标签（熟练度分析世界档）
  /** 世界国名标签的显示倍率阈值；省略时用渲染器默认（2.2）。未开始的浏览标签与熟练度分析传 0 = 任何倍率都显示。 */
  worldLabelZoomThreshold?: number;
  /**
   * **未开始的浏览标签**的内容（2026-09）：按当前取名口径给文本或图片（见 `BrowseLabelContent`）。
   *
   * `id` 是地级/省级的 adcode 或世界的 iso_a3（与 `colorOf` 同一套 id）。
   * 只在**中性全量标签**那几支生效（`showAllLabels` / `showAllProvinceLabels` / `worldShowAllLabels`）；
   * 已作答的绿/红标签仍走 `provinceLabel` / `worldLabel` —— 那是答题反馈，不随浏览口径变。
   */
  browseLabel?: (id: string) => BrowseLabelContent | null;
}
