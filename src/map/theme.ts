import type { BoundaryTone, UnitColor } from '../types';

export type ThemeName = 'light' | 'dark';
export type MapTheme = {
  background: string;
  fill: Record<UnitColor, string>;
  /**
   * **范围外惰性面**的填充色：关闭全局设置「下钻后隐藏无关地区」时，下钻范围之外的面
   * （其他省 / 其他洲的国家）画成这个颜色 —— 看得见，但不可交互。
   *
   * 取「比地图空白底色（`background`）更深一档的浅灰」：两者必须能一眼分开，
   * 否则用户分不清"这块是练习范围外的地区"还是"这里本来就没有内容"（用户口径 2026-09）。
   */
  inactiveFill: string;
  emphasis: Record<UnitColor, string>;
  boundary: Record<BoundaryTone, string>;
  hoverArea: string;
  labelBg: string;
  labelShadow: string;
  /** 图片标签（浏览态国旗）卡片的描边色：白底国旗在浅色主题下需要一圈轮廓才看得见。 */
  labelBorder: string;
  labelGreen: string;
  labelRed: string;
  labelNeutral: string;
  tooltipBg: string;
  tooltipText: string;
  tooltipBorder: string;
  flashArea: string;
  flashBorder: string;
  /** 无尽闯关：金币数量 → 绿色深浅（0/负值返回 null，回落原色） */
  coinGreen: (coins: number, hover?: boolean) => string | null;
};

export const MAP_THEMES: Record<ThemeName, MapTheme> = {
  light: {
    background: '#d1d5db',
    fill: {
      green: '#7fbf8b',
      blue: '#6fa8dc', // 当前题目
      red: '#d98989', // 答错标记
      gray: '#e7e2d8',
      scoreGreenLight: '#c7e8ce',
      scoreGreenMedium: '#86c993',
      scoreGreenDark: '#4f9d60',
      scoreRedLight: '#f0c8c8',
      scoreRedMedium: '#dc9292',
      scoreRedDark: '#bd5d5d',
    },
    inactiveFill: '#b0b5bd', // 比底色 #d1d5db 深一档的浅灰
    emphasis: {
      green: '#93cfa0',
      blue: '#83b7e3',
      red: '#e1a0a0',
      gray: '#eee9df',
      scoreGreenLight: '#d7f0dc',
      scoreGreenMedium: '#a2d8ac',
      scoreGreenDark: '#6bb87a',
      scoreRedLight: '#f6dada',
      scoreRedMedium: '#e5aaaa',
      scoreRedDark: '#cf7777',
    },
    boundary: {
      light: '#b9b2a6',
      mid: '#90969d',
      dark: '#6b7280',
    },
    hoverArea: 'rgba(255,255,255,0.22)',
    labelBg: 'rgba(255,255,255,0.94)',
    labelShadow: 'rgba(15, 23, 42, 0.22)',
    labelBorder: 'rgba(15, 23, 42, 0.28)',
    labelGreen: '#15803d',
    labelRed: '#b91c1c',
    labelNeutral: '#374151',
    tooltipBg: 'rgba(255,255,255,0.96)',
    tooltipText: '#111827',
    tooltipBorder: '#d1d5db',
    flashArea: '#e8cf78',
    flashBorder: '#b68b2f',
    coinGreen(coins, hover = false) {
      if (coins <= 0) return null;
      const t = Math.min(1, coins / 500);
      const s = 42 + t * 14;
      const l = Math.min(88, (hover ? 5 : 0) + (82 - t * 48));
      return `hsl(140, ${s.toFixed(1)}%, ${Math.max(26, l).toFixed(1)}%)`;
    },
  },
  dark: {
    background: '#374151',
    fill: {
      green: '#166534',
      blue: '#1d4ed8',
      red: '#991b1b',
      gray: '#1f2937',
      scoreGreenLight: '#3b7a4b',
      scoreGreenMedium: '#23703a',
      scoreGreenDark: '#166534',
      scoreRedLight: '#8b4b4b',
      scoreRedMedium: '#a23737',
      scoreRedDark: '#991b1b',
    },
    inactiveFill: '#2b3441', // 比底色 #374151 深一档（暗主题没有"浅灰"，对应关系与明主题一致）
    emphasis: {
      green: '#15803d',
      blue: '#2563eb',
      red: '#b91c1c',
      gray: '#334155',
      scoreGreenLight: '#4f985f',
      scoreGreenMedium: '#2d8a46',
      scoreGreenDark: '#15803d',
      scoreRedLight: '#a65b5b',
      scoreRedMedium: '#b83f3f',
      scoreRedDark: '#b91c1c',
    },
    boundary: {
      light: '#475569',
      mid: '#6b8197',
      dark: '#94a3b8',
    },
    hoverArea: 'rgba(148,163,184,0.18)',
    labelBg: 'rgba(15,23,42,0.9)',
    labelShadow: 'rgba(0, 0, 0, 0.42)',
    labelBorder: 'rgba(148, 163, 184, 0.42)',
    labelGreen: '#86efac',
    labelRed: '#fca5a5',
    labelNeutral: '#dbeafe',
    tooltipBg: 'rgba(15,23,42,0.96)',
    tooltipText: '#e5e7eb',
    tooltipBorder: '#475569',
    flashArea: '#ca8a04',
    flashBorder: '#fde68a',
    coinGreen(coins, hover = false) {
      if (coins <= 0) return null;
      const t = Math.min(1, coins / 500);
      const s = 48 + t * 16;
      const l = Math.min(64, (hover ? 9 : 0) + (26 + t * 22));
      return `hsl(140, ${s.toFixed(1)}%, ${Math.max(18, l).toFixed(1)}%)`;
    },
  },
};