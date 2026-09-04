export type Mode = 'free' | 'self' | 'endless' | 'click' | 'memory' | 'board' | 'admin';
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

export type BoundaryTone = 'light' | 'mid' | 'dark';

export interface AppData {
  units: Unit[]; // 真实记忆单位（不含装饰）
  allUnits: Unit[]; // 含装饰（南海诸岛等纯装饰面）
  provinces: Province[];
  geoJson: unknown; // 地级 + 装饰面
  provincesGeoJson: unknown; // 省界图层（粗线）
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
  darkMode: boolean;
}

export interface RoundResult {
  mode: Extract<Mode, 'self' | 'click' | 'endless'>;
  scopeProvince: string | null;
  scopeLabel: string;
  totalUnits: number;
  correct: number;
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

/** 每日竞速省名标签：省级 adcode → 简称文本 + 对错配色 */
export interface ProvinceLabel {
  text: string;
  color: 'green' | 'red';
}

export interface RenderState {
  colorOf: (adcode: string) => UnitColor;
  showAllLabels?: boolean; // 记忆模式：全部显示地名标签
  labelZoomThreshold?: number; // 地名标签显示倍率阈值
  disableTooltip?: boolean; // 记忆模式：关闭提示
  coin?: CoinLayer; // 无尽闯关：金币绿色深浅着色 + 中心金币/地名标签
  provinceLabel?: (provinceAdcode: string) => ProvinceLabel | null; // 每日竞速/省级练习：已作答省的省名标签（null = 不显示）
  showAllProvinceLabels?: boolean; // 省级地图常显全部省名标签（熟练度分析省级档）
}
