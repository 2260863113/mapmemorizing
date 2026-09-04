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
    expect(p).toEqual({ point: [10, 20], name: '广州', color: '#fff', isPrice: true, noBg: false });
  });

  it('returns null on NaN coord or empty/NaN text', () => {
    expect(parseLabelValue(api([0, 0, 'x', '#fff', 0, 0], [NaN, 20]))).toBeNull();
    expect(parseLabelValue(api([0, 0, '', '#fff', 0, 0], [10, 20]))).toBeNull();
    expect(parseLabelValue(api([0, 0, 'NaN', '#fff', 0, 0], [10, 20]))).toBeNull();
  });

  it('treats null text as empty', () => {
    expect(parseLabelValue(api([0, 0, null, '#fff', 0, 0], [10, 20]))).toBeNull();
  });
});

describe('buildLabelGraphic', () => {
  const base = { point: [100, 200], name: '广州', color: '#15803d', isPrice: false, noBg: false, scale: 1, theme, fontSize: 14, padX: 8, padY: 6, minWidth: 34, fontWeight: 600 };

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
});
