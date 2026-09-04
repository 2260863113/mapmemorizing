/**
 * 标签渲染纯函数（从 renderer.ts 抽出）。
 * 把 ECharts custom series 的标签绘制逻辑与图形构建拆为无副作用、可单测的纯函数。
 */
import type { MapTheme } from './theme';

export const CITY_LABEL_SIZE = 14;
export const PRICE_LABEL_SIZE = 18; // 价格标签字号（随缩放缩放）
export const PROVINCE_LABEL_SIZE = 15; // 省名标签字号（省级练习作答反馈）
export const LABEL_FIX_ZOOM = 4; // 标签固定大小阈值：4x 以上不再放大，4x 以下随地图缩放

/** custom series 的 api 最小接口（便于测试注入 mock）。 */
export interface LabelApi {
  value(index: number): unknown;
  coord(value: [number, number]): number[];
}

export interface ParsedLabel {
  point: number[];
  name: string;
  color: string;
  isPrice: boolean;
  noBg: boolean;
}

/** 标签缩放：缩放倍率 <4x 时跟随地图等比例缩放（下限 0.5），>=4x 时保持固定大小。 */
export function labelScale(zoom: number) {
  return Math.max(0.5, Math.min(1, zoom / LABEL_FIX_ZOOM));
}

/** 文本渲染宽度估算：CJK 按全角、ASCII 按半角。 */
export function textRenderWidth(text: string, fontSize: number) {
  let width = 0;
  for (const ch of text) {
    width += ch.charCodeAt(0) > 0xff ? fontSize : fontSize * 0.6;
  }
  return width;
}

/** 标签衬底矩形：按文本宽度居中，最小宽度兜底。 */
export function labelShape(name: string, point: number[], fontSize: number, padX: number, padY: number, minWidth: number) {
  const width = Math.max(minWidth, textRenderWidth(name, fontSize) + padX * 2);
  const height = fontSize + padY * 2;
  return {
    x: point[0] - width / 2,
    y: point[1] - height / 2,
    width,
    height,
  };
}

/**
 * 从 custom series api 解析标签 value（[lng, lat, text, color, isPrice, noBg]）。
 * ECharts 会把字符串数字转成 number，这里统一转字符串；坐标/文本非法返回 null。
 */
export function parseLabelValue(api: LabelApi): ParsedLabel | null {
  const value = [api.value(0), api.value(1)] as [number, number];
  const rawText = api.value(2);
  const name = rawText == null ? '' : String(rawText);
  const color = String(api.value(3));
  const isPrice = Number(api.value(4)) === 1;
  const noBg = Number(api.value(5)) === 1;
  const point = api.coord(value) as number[];
  // NaN 防御：坐标非有限或文本异常时跳过该标签，避免显示 "NaN"
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || !name || name === 'NaN' || name === 'undefined') {
    return null;
  }
  return { point, name, color, isPrice, noBg };
}

export interface LabelGraphicInput extends ParsedLabel {
  scale: number;
  theme: MapTheme;
  fontSize: number;
  padX: number;
  padY: number;
  minWidth: number;
  fontWeight: number; // 600 | 700
}

/** 构建标签图形（衬底矩形 + 文本；无衬底价格走白色文字 + 黑描边分支）。 */
export function buildLabelGraphic(input: LabelGraphicInput) {
  const { point, name, color, isPrice, noBg, scale, theme, fontSize, padX, padY, minWidth, fontWeight } = input;
  const font = `${fontWeight} ${fontSize}px Microsoft YaHei, PingFang SC, system-ui, sans-serif`;
  // 隐藏衬底的价格：无背景矩形，白色文字 + 细黑描边（固定 1-2px），不随字号变粗
  if (isPrice && noBg) {
    return {
      type: 'group' as const,
      children: [
        {
          type: 'text' as const,
          style: {
            x: point[0],
            y: point[1] + fontSize * 0.1,
            text: name,
            fill: '#ffffff',
            textBorderColor: '#000000',
            textBorderWidth: 1.5,
            font,
            align: 'center' as const,
            verticalAlign: 'middle' as const,
          },
        },
      ],
    };
  }
  const shape = labelShape(name, point, fontSize, padX, padY, minWidth);
  return {
    type: 'group' as const,
    children: [
      {
        type: 'rect' as const,
        shape,
        style: {
          fill: theme.labelBg,
          shadowColor: theme.labelShadow,
          shadowBlur: 8 * scale,
          shadowOffsetY: 2 * scale,
        },
      },
      {
        type: 'text' as const,
        style: {
          x: point[0],
          y: point[1] + (isPrice ? fontSize * 0.1 : 0), // 价格文本下移微调，保证垂直居中
          text: name,
          fill: color,
          font,
          align: 'center' as const,
          verticalAlign: 'middle' as const,
        },
      },
    ],
  };
}
