/**
 * 标签渲染纯函数（从 renderer.ts 抽出）。
 * 把 ECharts custom series 的标签绘制逻辑与图形构建拆为无副作用、可单测的纯函数。
 */
import type { MapTheme } from './theme';

export const CITY_LABEL_SIZE = 14;
export const PRICE_LABEL_SIZE = 18; // 价格标签字号（随缩放缩放）
export const PROVINCE_LABEL_SIZE = 15; // 省名标签字号（省级练习作答反馈）
export const LABEL_FIX_ZOOM = 4; // 标签固定大小阈值：4x 以上不再放大，4x 以下随地图缩放
/**
 * 地图标签上的国旗缩略图尺寸（4:3），与 `public/data/flags/thumbs/` 的 40×30 一致 ——
 * 那个尺寸由 `worldFlagsData.test.ts` 逐张断言，故这里的比例不会与真实文件悄悄漂移。
 */
export const FLAG_LABEL_W = 40;
export const FLAG_LABEL_H = 30;
/** 图片标签的缩放下限：文字缩到 0.5 倍还能认，40px 的国旗缩到 20px 就只剩色块了。 */
const FLAG_LABEL_MIN_SCALE = 0.6;

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
  /** 图片 URL（'' = 普通文本标签）。见 `buildLabelGraphic` 的图片分支。 */
  image: string;
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
 * 从 custom series api 解析标签 value（`[lng, lat, text, color, isPrice, noBg, image]`）。
 * ECharts 会把字符串数字转成 number，这里统一转字符串；坐标/文本非法返回 null。
 *
 * `image` 是 2026-09 新增的第 7 位（「国旗」档的浏览标签）：
 * 图片标签的 `text` 是空串，故"文本文本为空就丢弃"这条老规则要放宽成「文本与图片都空才丢弃」。
 */
export function parseLabelValue(api: LabelApi): ParsedLabel | null {
  const value = [api.value(0), api.value(1)] as [number, number];
  const rawText = api.value(2);
  const name = rawText == null ? '' : String(rawText);
  const color = String(api.value(3));
  const isPrice = Number(api.value(4)) === 1;
  const noBg = Number(api.value(5)) === 1;
  const rawImage = api.value(6);
  const image = rawImage == null || rawImage === 'undefined' ? '' : String(rawImage);
  const point = api.coord(value) as number[];
  // NaN 防御：坐标非有限或文本异常时跳过该标签，避免显示 "NaN"
  const textBad = !name || name === 'NaN' || name === 'undefined';
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || (textBad && !image)) {
    return null;
  }
  return { point, name, color, isPrice, noBg, image };
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

/**
 * 图片标签（「国旗」档的未开始浏览标签）：卡片 + 国旗小图。
 *
 * 卡片是不可省的：瑞士/日本/孟加拉这类白底或浅底国旗直接画在浅色地图上等于看不见，
 * 深色主题下又需要深色衬底；描边让浅色国旗在浅色主题里也有轮廓。
 * 尺寸按 4:3 的缩略图比例（FLAG_LABEL_W/H）+ 3px 内边距算，缩放下限见 FLAG_LABEL_MIN_SCALE。
 */
function flagLabelGraphic(point: number[], image: string, scale: number, theme: MapTheme) {
  const s = Math.max(FLAG_LABEL_MIN_SCALE, scale);
  const pad = 3 * s;
  const w = FLAG_LABEL_W * s;
  const h = FLAG_LABEL_H * s;
  return {
    type: 'group' as const,
    children: [
      {
        type: 'rect' as const,
        shape: { x: point[0] - w / 2 - pad, y: point[1] - h / 2 - pad, width: w + pad * 2, height: h + pad * 2 },
        style: {
          fill: theme.labelBg,
          stroke: theme.labelBorder,
          lineWidth: 1,
          shadowColor: theme.labelShadow,
          shadowBlur: 8 * scale,
          shadowOffsetY: 2 * scale,
        },
      },
      {
        type: 'image' as const,
        // zrender 的 image 接受**字符串 URL**：加载完成后它自己调 hostEl.dirty() 触发重绘
        // （见 zrender/lib/graphic/helper/image.js），所以这里不需要任何"图片就绪后再刷一次"的机制。
        style: { image, x: point[0] - w / 2, y: point[1] - h / 2, width: w, height: h },
      },
    ],
  };
}

/** 构建标签图形（衬底矩形 + 文本；无衬底价格走白色文字 + 黑描边分支；图片标签走国旗卡片分支）。 */
export function buildLabelGraphic(input: LabelGraphicInput) {
  const { point, name, color, isPrice, noBg, image, scale, theme, fontSize, padX, padY, minWidth, fontWeight } = input;
  const font = `${fontWeight} ${fontSize}px Microsoft YaHei, PingFang SC, system-ui, sans-serif`;
  if (image) return flagLabelGraphic(point, image, scale, theme);
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
