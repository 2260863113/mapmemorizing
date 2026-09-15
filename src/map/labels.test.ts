import { describe, it, expect } from 'vitest';
import {
  labelScale,
  textRenderWidth,
  labelShape,
  parseLabelValue,
  buildLabelGraphic,
  type LabelApi,
} from './labels';
import { MAP_THEMES } from './theme';

const theme = MAP_THEMES.light;

function api(values: unknown[], coord: number[]): LabelApi {
  return {
    value: (i: number) => values[i],
    coord: () => coord,
  };
}

describe('labelScale', () => {
  it('scales linearly below fix zoom with 0.5 floor', () => {
    expect(labelScale(0)).toBe(0.5);
    expect(labelScale(2)).toBe(0.5); // 2/4 = 0.5
    expect(labelScale(4)).toBe(1);
    expect(labelScale(10)).toBe(1);
  });
});

describe('textRenderWidth', () => {
  it('CJK full-width, ASCII half-width', () => {
    expect(textRenderWidth('中', 10)).toBe(10);
    expect(textRenderWidth('A', 10)).toBe(6);
    expect(textRenderWidth('中A', 10)).toBe(16);
  });
});

describe('labelShape', () => {
  it('centers box on point with min width', () => {
    const s = labelShape('中', [100, 200], 10, 4, 3, 30);
    expect(s.width).toBe(30); // minWidth wins
    expect(s.x).toBe(100 - 30 / 2);
    expect(s.y).toBe(200 - (10 + 6) / 2);
  });
});

describe('parseLabelValue', () => {
  it('parses value tuple, coercing numeric strings', () => {
    const p = parseLabelValue(api([100.5, 30.2, '广州', '#fff', 1, 0], [10, 20]));
    expect(p).toEqual({ point: [10, 20], name: '广州', color: '#fff', isPrice: true, noBg: false, image: '' });
  });

  it('returns null on NaN coord or empty/NaN text', () => {
    expect(parseLabelValue(api([0, 0, 'x', '#fff', 0, 0], [NaN, 20]))).toBeNull();
    expect(parseLabelValue(api([0, 0, '', '#fff', 0, 0], [10, 20]))).toBeNull();
    expect(parseLabelValue(api([0, 0, 'NaN', '#fff', 0, 0], [10, 20]))).toBeNull();
  });

  it('treats null text as empty', () => {
    expect(parseLabelValue(api([0, 0, null, '#fff', 0, 0], [10, 20]))).toBeNull();
  });

  /**
   * 图片标签（第 7 位）：「国旗」档的浏览标签是**没有文字**的，故"文本为空就丢弃"必须放宽，
   * 否则整档国旗在标签层被静默丢光（地图上什么都不显示，且不报错）。
   */
  it('accepts an image label with empty text', () => {
    const p = parseLabelValue(api([100, 20, '', '#374151', 0, 0, 'data/flags/thumbs/jp.webp'], [10, 20]));
    expect(p?.image).toBe('data/flags/thumbs/jp.webp');
    expect(p?.name).toBe('');
  });

  it('old 6-slot data has no image (undefined/缺失都算没有)', () => {
    expect(parseLabelValue(api([0, 0, '广州', '#fff', 0, 0], [10, 20]))?.image).toBe('');
    expect(parseLabelValue(api([0, 0, '广州', '#fff', 0, 0, undefined], [10, 20]))?.image).toBe('');
    expect(parseLabelValue(api([0, 0, '广州', '#fff', 0, 0, 'undefined'], [10, 20]))?.image).toBe('');
  });
});

describe('buildLabelGraphic', () => {
  const base = { point: [100, 200], name: '广州', color: '#15803d', isPrice: false, noBg: false, image: '', scale: 1, theme, fontSize: 14, padX: 8, padY: 6, minWidth: 34, fontWeight: 600 };

  it('builds rect + text group', () => {
    const g = buildLabelGraphic(base) as { type: string; children: { type: string }[] };
    expect(g.type).toBe('group');
    expect(g.children.map((c) => c.type)).toEqual(['rect', 'text']);
  });

  it('price without background renders single text with border', () => {
    const g = buildLabelGraphic({ ...base, isPrice: true, noBg: true, fontSize: 18, fontWeight: 700 }) as { type: string; children: { type: string; style: { textBorderColor?: string; textBorderWidth?: number } }[] };
    expect(g.children).toHaveLength(1);
    expect(g.children[0].type).toBe('text');
    expect(g.children[0].style.textBorderColor).toBe('#000000');
  });

  /**
   * 图片标签（「国旗」档的浏览标签）：卡片 + 国旗小图，尺寸是 4:3 的 40×30 加 3px 内边距，
   * 整体以锚点为中心；缩放有下限（文字缩到 0.5 倍还能认，国旗缩到 20px 只剩色块）。
   */
  it('image label = centered card + flag image', () => {
    const g = buildLabelGraphic({ ...base, name: '', image: 'data/flags/thumbs/jp.webp' }) as {
      type: string;
      children: { type: string; shape?: { x: number; y: number; width: number; height: number }; style: Record<string, unknown> }[];
    };
    expect(g.children.map((c) => c.type)).toEqual(['rect', 'image']);
    const [rect, img] = g.children;
    // 图 40×30 居中于 (100,200)；卡片每边多 3px
    expect(img.style).toMatchObject({ image: 'data/flags/thumbs/jp.webp', x: 80, y: 185, width: 40, height: 30 });
    expect(rect.shape).toEqual({ x: 77, y: 182, width: 46, height: 36 });
    expect(rect.style.stroke).toBe(theme.labelBorder); // 白底国旗在浅色主题下靠这圈描边才看得见
  });

  it('image label keeps a scale floor (0.6) so flags never shrink to blobs', () => {
    const g = buildLabelGraphic({ ...base, name: '', image: 'x.webp', scale: 0.5 }) as {
      children: { type: string; shape?: { width: number }; style: Record<string, unknown> }[];
    };
    expect(g.children[1].style.width).toBe(40 * 0.6);
    expect(g.children[0].shape?.width).toBe(40 * 0.6 + 3 * 0.6 * 2);
  });
});
