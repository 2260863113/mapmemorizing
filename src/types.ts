export type Mode = 'free' | 'self' | 'challenge' | 'click' | 'memory';
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
  name: string; // 官方全名（地级）或短名（北京/上海等整体单位）
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

export interface AppData {
  units: Unit[]; // 真实记忆单位（不含装饰）
  allUnits: Unit[]; // 含装饰（省直辖县级填充面、南海诸岛）
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
  selfTimerEnabled: boolean;
  selfTimerSeconds: number;
  challengeSeconds: number;
  requireEnter: boolean;
  autoFollow: boolean;
  followZoom: number;
  darkMode: boolean;
}

export interface RenderState {
  colorOf: (adcode: string) => UnitColor;
  showAllLabels?: boolean; // 记忆模式：全部显示地名标签
  disableTooltip?: boolean; // 记忆模式：关闭提示
}
