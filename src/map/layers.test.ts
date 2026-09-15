import { describe, it, expect } from 'vitest';
import { makeAppData } from '../testFixture';
import { MAP_THEMES } from './theme';
import {
  buildLabelData,
  buildProvinceEventData,
  buildProvinceLabelData,
  buildProvinceRegionData,
  buildRegionData,
  buildWorldEventData,
  buildWorldLabelData,
  buildWorldRegionData,
  labelAnchorOf,
  type LayerInput,
} from './layers';
import type { AppData, Continent, RenderState, SubregionId, Unit } from '../types';

/**
 * 渲染数据层的单测。
 *
 * 为什么这些用例重要：这里锁的几条规则**以前只能靠 headless Edge 的运行时探针验证**
 * （`scripts/verify-round2.mjs` 的 `renderedRegions` 断言「范围外的面是 silent + 透明」），
 * 而它们恰恰是最不该依赖浏览器的那类逻辑 —— 纯数据变换。
 *
 * 这些方法原先都是 `MapRenderer` 的私有方法，无法单测；抽到 `./layers.ts` 之后，
 * 构造一个合成 `LayerInput` 就能直接断言。
 */

const THEME = MAP_THEMES.light;
const TRANSPARENT = 'rgba(0,0,0,0)';

// ==================== 固件 ====================

function unit(over: Partial<Unit> & { adcode: string; name: string }): Unit {
  return {
    shortName: over.name,
    province: '广东省',
    provinceAdcode: '440000',
    center: [100, 30],
    neighbors: [],
    ...over,
  };
}

const UNITS: Unit[] = [
  unit({ adcode: '440100', name: '广州', center: [113.26, 23.13] }),
  unit({ adcode: '440300', name: '深圳', center: [114.06, 22.55] }),
  unit({ adcode: '350100', name: '福州', province: '福建省', provinceAdcode: '350000', center: [119.3, 26.08] }),
  // 装饰面挂在海南（真实数据里也是），不要与广东的用例互相污染
  unit({ adcode: '100000_JD', name: '南海诸岛', decorative: true, provinceAdcode: '460000', province: '海南省' }),
];

/** 世界面：三个答题国 + 一个装饰面 + 一个会被「忽略极小国家」排除的国。 */
const WORLD_GEO = {
  features: [
    { properties: { name: '中国', iso_a3: 'CHN' } },
    { properties: { name: '法国', iso_a3: 'FRA' } },
    { properties: { name: '巴西', iso_a3: 'BRA' } },
    { properties: { name: '南极洲', iso_a3: 'ATA', decorative: 1 } },
    { properties: { name: '摩纳哥', iso_a3: 'MCO' } },
  ],
};

const PROV_GEO = {
  features: [
    { properties: { name: '广东省', adcode: '440000' } },
    { properties: { name: '福建省', adcode: '350000' } },
    { properties: { name: '南海诸岛', adcode: '100000_JD' } },
  ],
};

const ISO_CONTINENT = new Map<string, Continent>([
  ['CHN', 'AS'],
  ['FRA', 'EU'],
  ['BRA', 'SA'],
]);
const ISO_SUBREGION = new Map<string, SubregionId>([
  ['CHN', 'EAS'],
  ['FRA', 'WEU'],
  ['BRA', 'SAM'],
]);

const DATA: AppData = makeAppData({
  units: UNITS,
  allUnits: UNITS,
  provinces: [
    { adcode: '440000', name: '广东省', center: [113.4, 23.4] },
    { adcode: '350000', name: '福建省', center: [118.0, 26.0] },
  ],
  countries: [
    { iso: 'CHN', name: '中国', fullName: '中华人民共和国', center: [104, 35], continent: 'AS', neighbors: [] },
    { iso: 'FRA', name: '法国', fullName: '法兰西共和国', center: [2, 46], continent: 'EU', neighbors: [] },
    { iso: 'BRA', name: '巴西', fullName: '巴西联邦共和国', center: [-52, -10], continent: 'SA', neighbors: [] },
  ],
  provincesGeoJson: PROV_GEO,
  worldGeoJson: WORLD_GEO,
});

function ctx(over: Partial<Omit<LayerInput, 'state'>> & { state?: Partial<RenderState> } = {}): LayerInput {
  const base: Omit<LayerInput, 'state'> = {
    data: DATA,
    theme: THEME,
    zoom: 1,
    worldMode: false,
    provinceMode: false,
    viewProvince: null,
    labelMode: 'none',
    worldContinent: null,
    worldSubregion: null,
    cityBoundaryTone: 'light',
    worldBoundaryTone: 'mid',
    hideUnrelatedOnDrill: true, // 默认（= 历史观感）：范围外的面透明
    excludedIso: new Set<string>(),
    units: UNITS,
    labelAnchors: new Map(),
    provinceLabelAnchors: new Map(),
    worldLabelAnchors: new Map(),
    isoContinent: ISO_CONTINENT,
    isoSubregion: ISO_SUBREGION,
  };
  const baseState: RenderState = { colorOf: () => 'gray' };
  return { ...base, ...over, state: { ...baseState, ...over.state } };
}

const regionOf = (regions: { name?: string }[], name: string) =>
  regions.find((r) => r.name === name) as {
    silent?: boolean;
    itemStyle?: { areaColor?: string; borderColor?: string; borderWidth?: number };
    emphasis?: { disabled?: boolean };
  };

// ==================== 世界面 ====================

describe('buildWorldRegionData', () => {
  it('范围外的面仍然登记，但 silent + 透明 + emphasis 关闭', () => {
    // 这是 README 记过的坑：只跳过外观会让这些面回落到 geo 默认样式，
    // 于是「空白处悬停高亮看不见的国家、点击跳到它的上级区域」。
    const regions = buildWorldRegionData(ctx({ worldMode: true, worldContinent: 'AS' }));
    const fra = regionOf(regions, '法国');
    expect(fra.silent).toBe(true);
    expect(fra.itemStyle?.areaColor).toBe(TRANSPARENT);
    expect(fra.itemStyle?.borderWidth).toBe(0);
    expect(fra.emphasis?.disabled).toBe(true);
  });

  it('范围外的面依然出现在 regions 里（否则 ECharts 会当默认面处理）', () => {
    const regions = buildWorldRegionData(ctx({ worldMode: true, worldContinent: 'AS' }));
    expect(regions.map((r) => r.name)).toContain('法国');
    expect(regions.map((r) => r.name)).toContain('巴西');
  });

  it('范围外的面与答题国面数是同一批（全体几何都登记）', () => {
    const regions = buildWorldRegionData(ctx({ worldMode: true, worldContinent: 'AS' }));
    expect(regions).toHaveLength(WORLD_GEO.features.length);
  });

  it('范围外的面即使被着色回调判定为绿色也不着色', () => {
    const regions = buildWorldRegionData(
      ctx({ worldMode: true, worldContinent: 'AS', state: { colorOf: () => 'green' } }),
    );
    expect(regionOf(regions, '法国').itemStyle?.areaColor).toBe(TRANSPARENT);
    expect(regionOf(regions, '中国').itemStyle?.areaColor).toBe(THEME.fill.green);
  });

  it('答题国按 colorOf 着色且可交互，边界宽 0.4', () => {
    const regions = buildWorldRegionData(
      ctx({ worldMode: true, state: { colorOf: (iso) => (iso === 'CHN' ? 'green' : 'gray') } }),
    );
    const chn = regionOf(regions, '中国');
    expect(chn.silent).toBe(false);
    expect(chn.itemStyle?.areaColor).toBe(THEME.fill.green);
    expect(chn.itemStyle?.borderWidth).toBe(0.4);
  });

  it('装饰面灰显且静默', () => {
    const regions = buildWorldRegionData(ctx({ worldMode: true }));
    const ata = regionOf(regions, '南极洲');
    expect(ata.silent).toBe(true);
    expect(ata.emphasis?.disabled).toBe(true);
    expect(ata.itemStyle?.areaColor).toBe(THEME.fill.gray);
  });

  it('被「忽略极小国家」排除的面灰显、静默、边界更细', () => {
    const regions = buildWorldRegionData(ctx({ worldMode: true, excludedIso: new Set(['MCO']) }));
    const mco = regionOf(regions, '摩纳哥');
    expect(mco.silent).toBe(true);
    expect(mco.emphasis?.disabled).toBe(true);
    expect(mco.itemStyle?.areaColor).toBe(THEME.fill.gray);
    expect(mco.itemStyle?.borderWidth).toBe(0.2); // 区别于答题国的 0.4
  });

  it('边界颜色跟随 worldBoundaryTone 设置', () => {
    const light = buildWorldRegionData(ctx({ worldMode: true, worldBoundaryTone: 'light' }));
    expect(regionOf(light, '中国').itemStyle?.borderWidth).toBe(0.4);
    const dark = buildWorldRegionData(ctx({ worldMode: true, worldBoundaryTone: 'dark' }));
    // 深浅只影响颜色，不影响宽度
    expect(regionOf(dark, '中国').itemStyle?.borderWidth).toBe(0.4);
  });

  /**
   * 全局设置「下钻后隐藏无关地区」关闭时：范围外的面**保留可见**（浅灰 + 国界），
   * 但**仍然不可交互** —— 可见性只改画法，不改"能不能点"。
   */
  describe('关闭「下钻后隐藏无关地区」', () => {
    const OFF = { worldMode: true, worldContinent: 'AS' as const, hideUnrelatedOnDrill: false };

    it('范围外的面改成浅灰填充（不再是透明），且仍 silent + 不可高亮', () => {
      const regions = buildWorldRegionData(ctx(OFF));
      const fra = regionOf(regions, '法国');
      expect(fra.itemStyle?.areaColor).toBe(THEME.inactiveFill);
      expect(fra.itemStyle?.areaColor).not.toBe(TRANSPARENT);
      expect(fra.silent).toBe(true);
      expect(fra.emphasis?.disabled).toBe(true);
    });

    it('范围外的面照画国界（否则整片浅灰会糊成一块看不出国别）', () => {
      const regions = buildWorldRegionData(ctx(OFF));
      expect(regionOf(regions, '法国').itemStyle?.borderWidth).toBe(0.4);
      // 国界深浅仍跟随全局设置
      const dark = buildWorldRegionData(ctx({ ...OFF, worldBoundaryTone: 'dark' }));
      expect(regionOf(dark, '法国').itemStyle?.borderColor).toBe(THEME.boundary.dark);
    });

    it('范围内与范围外的画法必须不同：本洲国面照常按答题态着色', () => {
      const regions = buildWorldRegionData(
        ctx({ ...OFF, state: { colorOf: (iso) => (iso === 'CHN' ? 'green' : 'gray') } }),
      );
      expect(regionOf(regions, '中国').itemStyle?.areaColor).toBe(THEME.fill.green);
      expect(regionOf(regions, '法国').itemStyle?.areaColor).toBe(THEME.inactiveFill);
    });

    it('浅灰比地图空白底色更深（用户口径：要让"看得到但不能动"和"这里本来就没内容"分开）', () => {
      // 亮度加权近似（0.299R + 0.587G + 0.114B），只用来锁"更深"这个方向
      const luma = (hex: string) => {
        const n = parseInt(hex.slice(1), 16);
        return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
      };
      expect(luma(THEME.inactiveFill)).toBeLessThan(luma(THEME.background));
    });
  });
});

describe('buildWorldEventData', () => {
  it('装饰面不参与事件', () => {
    const names = buildWorldEventData(ctx({ worldMode: true })).map((d) => d.name);
    expect(names).not.toContain('南极洲');
  });

  it('下钻到大洲后只保留本洲的国面', () => {
    const names = buildWorldEventData(ctx({ worldMode: true, worldContinent: 'AS' })).map((d) => d.name);
    expect(names).toEqual(['中国']);
  });
});

// ==================== 国名标签 ====================

describe('buildWorldLabelData', () => {
  it('非世界模式整组不画', () => {
    expect(buildWorldLabelData(ctx())).toEqual([]);
  });

  it('「隐藏地图标签」关闭整组', () => {
    const labels = buildWorldLabelData(
      ctx({ worldMode: true, state: { hideLabels: true, worldShowAllLabels: true } }),
    );
    expect(labels).toEqual([]);
  });

  const anchors = new Map<string, [number, number]>([
    ['CHN', [104, 35]],
    ['FRA', [2, 46]],
    ['BRA', [-52, -10]],
  ]);

  it('测验档：已作答国显示绿/红，未作答不显示', () => {
    const labels = buildWorldLabelData(
      ctx({
        worldMode: true,
        worldLabelAnchors: anchors,
        state: { worldLabel: (iso) => (iso === 'CHN' ? { text: '中国', color: 'green' as const } : null) },
      }),
    );
    expect(labels.map((l) => l.name)).toEqual(['中国']);
    expect(labels[0].value[3]).toBe(THEME.labelGreen);
  });

  /**
   * 回归闸门（2026-09 实测缺陷）：未开始的浏览标签与测验的 worldLabel **同时存在**时，
   * 旧实现在 worldLabel 分支里 `return out`，把全量浏览标签整段吃掉 ——
   * 表现是「点击/输入模式世界档未开始时不显示国名」（省级/地级两档却正常）。
   */
  it('测验档 + 浏览态同时存在：已作答保留绿/红，其余补中性色（不被 worldLabel 吃掉）', () => {
    const labels = buildWorldLabelData(
      ctx({
        worldMode: true,
        worldLabelAnchors: anchors,
        state: {
          worldLabel: (iso) => (iso === 'CHN' ? { text: '中国', color: 'green' as const } : null),
          worldShowAllLabels: true,
          worldLabelZoomThreshold: 0, // 未开始的浏览标签：任何倍率都显示
        },
      }),
    );
    expect(new Set(labels.map((l) => l.name))).toEqual(new Set(['中国', '法国', '巴西']));
    const china = labels.find((l) => l.name === '中国')!;
    const fra = labels.find((l) => l.name === '法国')!;
    expect(china.value[3]).toBe(THEME.labelGreen); // 已作答：保留答题反馈色
    expect(fra.value[3]).toBe(THEME.labelNeutral); // 未作答：中性浏览标签
    expect(china.value[2]).toBe('中国'); // 文本用当前取名口径（此处即国名）
  });

  it('分析档：未到倍率阈值时不常显', () => {
    const labels = buildWorldLabelData(
      ctx({ worldMode: true, zoom: 1, worldLabelAnchors: anchors, state: { worldShowAllLabels: true } }),
    );
    expect(labels).toEqual([]);
  });

  it('分析档：超过阈值后全部国名中性色常显', () => {
    const labels = buildWorldLabelData(
      ctx({ worldMode: true, zoom: 3, worldLabelAnchors: anchors, state: { worldShowAllLabels: true } }),
    );
    // 顺序即 countries 顺序，故用集合比较（中文名的默认 sort 是码点序，写死顺序反而脆）
    expect(new Set(labels.map((l) => l.name))).toEqual(new Set(['中国', '法国', '巴西']));
    expect(labels[0].value[3]).toBe(THEME.labelNeutral);
  });

  it('RenderState 的阈值覆盖默认值', () => {
    const labels = buildWorldLabelData(
      ctx({
        worldMode: true,
        zoom: 3,
        worldLabelAnchors: anchors,
        state: { worldShowAllLabels: true, worldLabelZoomThreshold: 5 },
      }),
    );
    expect(labels).toEqual([]); // 3 < 5
  });

  it('次区域范围优先于大洲范围', () => {
    const labels = buildWorldLabelData(
      ctx({
        worldMode: true,
        zoom: 3,
        worldContinent: 'AS',
        worldSubregion: 'EAS',
        worldLabelAnchors: anchors,
        state: { worldShowAllLabels: true },
      }),
    );
    expect(labels.map((l) => l.name)).toEqual(['中国']); // 同属亚洲，但不属东亚的国不显示
  });
});

// ==================== 地级 ====================

describe('buildLabelData', () => {
  it('世界模式整组不画（国名走 world-labels 系列）', () => {
    expect(buildLabelData(ctx({ worldMode: true, labelMode: 'city' }))).toEqual([]);
  });

  it('「隐藏地图标签」与非 city 标签档都整组不画', () => {
    expect(buildLabelData(ctx({ labelMode: 'city', state: { hideLabels: true } }))).toEqual([]);
    expect(buildLabelData(ctx({ labelMode: 'none' }))).toEqual([]);
  });

  it('答题态为蓝的当前题目不显示标签（不泄露答案）', () => {
    const labels = buildLabelData(
      ctx({ labelMode: 'city', state: { colorOf: (code) => (code === '440100' ? 'blue' : 'gray') } }),
    );
    expect(labels.map((l) => l.name)).not.toContain('广州');
  });

  it('已作答单位显示绿/红', () => {
    const labels = buildLabelData(
      ctx({
        labelMode: 'city',
        state: { colorOf: (code) => (code === '440100' ? 'green' : code === '440300' ? 'red' : 'gray') },
      }),
    );
    const byName = new Map(labels.map((l) => [l.name, l.value[3]]));
    expect(byName.get('广州')).toBe(THEME.labelGreen);
    expect(byName.get('深圳')).toBe(THEME.labelRed);
  });

  it('常显开关让未作答单位也显示中性色标签', () => {
    const labels = buildLabelData(ctx({ labelMode: 'city', state: { showAllLabels: true } }));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((l) => l.value[3] === THEME.labelNeutral)).toBe(true);
  });

  it('下钻某省时只画本省单位的标签', () => {
    const labels = buildLabelData(ctx({ labelMode: 'city', viewProvince: '440000', state: { showAllLabels: true } }));
    expect(labels.map((l) => l.name).sort()).toEqual(['广州', '深圳']);
  });
});

describe('buildRegionData', () => {
  it('下钻某省后，省外单位静默且透明', () => {
    const regions = buildRegionData(ctx({ viewProvince: '440000' }));
    const fz = regionOf(regions, '福州');
    expect(fz.silent).toBe(true);
    expect(fz.itemStyle?.areaColor).toBe(TRANSPARENT);
  });

  /**
   * 关闭「下钻后隐藏无关地区」：省外的面画成浅灰（看得见其他地区），但依旧 `silent`
   * —— 悬停不高亮、点击等同点空白（与「装饰面 / 被排除的极小国」同一套惰性面口径）。
   */
  it('关闭该设置后：下钻某省时省外面浅灰可见，但仍静默、不画地级边界', () => {
    const regions = buildRegionData(ctx({ viewProvince: '440000', hideUnrelatedOnDrill: false }));
    const fz = regionOf(regions, '福州');
    expect(fz.itemStyle?.areaColor).toBe(THEME.inactiveFill);
    expect(fz.silent).toBe(true);
    expect(fz.itemStyle?.borderWidth).toBe(0);
    // 本省单位不受影响：照常着色 + 画边界
    const gz = regionOf(regions, '广州');
    expect(gz.silent).toBe(false);
    expect(gz.itemStyle?.areaColor).toBe(THEME.fill.gray);
    expect(gz.itemStyle?.borderWidth).toBe(0.6);
  });

  it('范围外的判定优先于无尽闯关的金币着色：省外仍是浅灰，本省才按金币上色', () => {
    const coin = { coins: () => 300, label: () => null };
    const regions = buildRegionData(
      ctx({ viewProvince: '440000', hideUnrelatedOnDrill: false, state: { coin } }),
    );
    expect(regionOf(regions, '广州').itemStyle?.areaColor).toBe(THEME.coinGreen(300));
    expect(regionOf(regions, '福州').itemStyle?.areaColor).toBe(THEME.inactiveFill);
  });

  it('没下钻时该设置不影响任何面（范围外为空集）', () => {
    const on = buildRegionData(ctx({ state: { colorOf: () => 'green' } }));
    const off = buildRegionData(ctx({ hideUnrelatedOnDrill: false, state: { colorOf: () => 'green' } }));
    expect(off.map((r) => r.itemStyle?.areaColor)).toEqual(on.map((r) => r.itemStyle?.areaColor));
  });

  it('省级模式不画地级边界', () => {
    const regions = buildRegionData(ctx({ provinceMode: true, state: { colorOf: () => 'green' } }));
    expect(regionOf(regions, '广州').itemStyle?.borderWidth).toBe(0);
  });

  it('装饰面保持灰色', () => {
    const regions = buildRegionData(ctx({ state: { colorOf: () => 'green' } }));
    expect(regionOf(regions, '南海诸岛').itemStyle?.areaColor).toBe(THEME.fill.gray);
  });
});

// ==================== 省级 ====================

describe('buildProvinceRegionData / buildProvinceEventData', () => {
  it('南海诸岛省面静默且灰色（装饰面）', () => {
    const regions = buildProvinceRegionData(ctx({ provinceMode: true }));
    const jd = regionOf(regions, '南海诸岛');
    expect(jd.silent).toBe(true);
    expect(jd.itemStyle?.areaColor).toBe(THEME.fill.gray);
  });

  it('省级事件面排除南海诸岛', () => {
    const names = buildProvinceEventData(DATA).map((d) => d.name);
    expect(names).toEqual(['广东省', '福建省']);
  });
});

describe('buildProvinceLabelData', () => {
  const anchors = new Map<string, [number, number]>([
    ['440000', [113.4, 23.4]],
    ['350000', [118.0, 26.0]],
  ]);

  it('非省级模式整组不画', () => {
    expect(buildProvinceLabelData(ctx({ provinceLabelAnchors: anchors }))).toEqual([]);
  });

  it('熟练度分析省级档：全部省名中性色常显', () => {
    const labels = buildProvinceLabelData(
      ctx({ provinceMode: true, provinceLabelAnchors: anchors, state: { showAllProvinceLabels: true } }),
    );
    expect(labels.map((l) => l.name).sort()).toEqual(['广东省', '福建省']);
    expect(labels[0].value[3]).toBe(THEME.labelNeutral);
  });

  it('测验档：只有已作答省显示，且用绿/红', () => {
    const labels = buildProvinceLabelData(
      ctx({
        provinceMode: true,
        provinceLabelAnchors: anchors,
        state: { provinceLabel: (code) => (code === '440000' ? { text: '广东', color: 'green' as const } : null) },
      }),
    );
    expect(labels.map((l) => l.name)).toEqual(['广东省']);
    expect(labels[0].value[2]).toBe('广东');
    expect(labels[0].value[3]).toBe(THEME.labelGreen);
  });

  it('没有锚点的省不产生标签', () => {
    const labels = buildProvinceLabelData(
      ctx({
        provinceMode: true,
        provinceLabelAnchors: new Map([['440000', [113.4, 23.4]]]),
        state: { showAllProvinceLabels: true },
      }),
    );
    expect(labels.map((l) => l.name)).toEqual(['广东省']);
  });
});

// ==================== 锚点 ====================

describe('labelAnchorOf', () => {
  it('优先用主面质心锚点', () => {
    const anchors = new Map<string, [number, number]>([['440100', [113.26, 23.13]]]);
    expect(labelAnchorOf(anchors, UNITS[0])).toEqual([113.26, 23.13]);
  });

  it('没有锚点时回落单位自带 center', () => {
    expect(labelAnchorOf(new Map(), UNITS[0])).toEqual([113.26, 23.13]);
  });
});
