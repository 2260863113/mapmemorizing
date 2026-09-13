import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isPureDecoration } from './data';
import type { Unit } from './types';

function unit(over: Partial<Unit>): Unit {
  return {
    adcode: '110000',
    name: 'x',
    shortName: 'x',
    province: 'p',
    provinceAdcode: '110000',
    center: [0, 0],
    neighbors: [],
    ...over,
  };
}

/**
 * 回归闸门：2026-09 数据管线把 32 个省直辖县级/兵团填充面标成 `decorative: true` 后，
 * 旧的 `isPureDecoration`（只认 100000_JD）会把它们洗成可答题单位，答题池从 340 涨到 372。
 * 设计口径（DESIGN.md §2/§4.2）是：装饰面参与绘制与邻接，但**不参与匹配/统计/测试**。
 */
describe('isPureDecoration', () => {
  it('认数据里的装饰面标注（省直辖县级 / 兵团城市）', () => {
    for (const adcode of ['429004', '419001', '659012', '469030']) {
      expect(isPureDecoration(unit({ adcode, decorative: true })), adcode).toBe(true);
    }
  });

  it('南海诸岛无论有没有标注都算装饰面', () => {
    expect(isPureDecoration(unit({ adcode: '100000_JD' }))).toBe(true);
    expect(isPureDecoration(unit({ adcode: '100000_JD', decorative: true }))).toBe(true);
  });

  it('普通地级单位不是装饰面', () => {
    for (const adcode of ['110000', '130100', '510100']) {
      expect(isPureDecoration(unit({ adcode })), adcode).toBe(false);
      expect(isPureDecoration(unit({ adcode, decorative: false })), adcode).toBe(false);
    }
  });

  it('真实 units.json：装饰面 33 个，答题池 340 个（与 DESIGN.md 口径一致）', () => {
    const meta = JSON.parse(readFileSync(path.join(process.cwd(), 'public', 'data', 'units.json'), 'utf8')) as { units: Unit[] };
    const decorative = meta.units.filter((u) => isPureDecoration(u));
    const answerable = meta.units.filter((u) => !isPureDecoration(u));
    expect(meta.units).toHaveLength(373);
    expect(decorative).toHaveLength(33);
    expect(answerable).toHaveLength(340);
    // 省直辖县级/兵团城市确实都在装饰面里（否则会被当题出出来）
    for (const adcode of ['429004', '419001', '469001', '659001']) {
      expect(decorative.some((u) => u.adcode === adcode), adcode).toBe(true);
    }
  });
});
