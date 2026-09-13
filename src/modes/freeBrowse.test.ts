import { describe, it, expect } from 'vitest';
import { FreeBrowseMode } from './freeBrowse';
import type { ModeCtx } from './types';
import type { RenderState } from '../types';

/**
 * 自由模式本轮的行为约束：
 *   1. 沿用「世界/省级/市级」分段按钮对应的粒度（默认市级），切档即切地图；
 *   2. **不支持下钻** —— 双击不改变视图，也不调用钻省；
 *   3. 「隐藏标签」开关把 hideLabels 传进渲染状态，三档一致。
 *
 * 用最小假渲染器记录调用，不依赖 DOM / ECharts。
 */
function makeCtx() {
  const calls: string[] = [];
  const states: RenderState[] = [];
  const renderer = {
    setWorldMode: (on: boolean, continent: unknown, subregion: unknown) => {
      calls.push(`world:${on}:${continent ?? '-'}:${subregion ?? '-'}`);
    },
    setProvinceMode: (on: boolean, opts: { inset?: boolean; allowDrill?: boolean } = {}) => {
      calls.push(`province:${on}:${opts.inset ?? 'def'}:${opts.allowDrill ?? 'def'}`);
    },
    render: (state: RenderState) => {
      states.push(state);
    },
    drillToProvince: (adcode: string) => calls.push(`drill:${adcode}`),
    backToNation: () => calls.push('backToNation'),
    currentProvince: () => null,
  };
  const ctx = {
    data: { units: [], allUnits: [], provinces: [], countries: [] },
    renderer,
    setHint: () => {},
    byAdcode: new Map(),
  } as unknown as ModeCtx;
  return { ctx, calls, states };
}

describe('FreeBrowseMode', () => {
  it('默认走市级档：地级地图 + 全部地名标签默认常显（阈值 0）+ 不下钻', () => {
    const { ctx, calls, states } = makeCtx();
    const mode = new FreeBrowseMode(ctx);
    mode.enter();
    expect(mode.getGranularity()).toBe('city');
    expect(calls).toContain('province:false:false:def');
    expect(states.at(-1)?.showAllLabels).toBe(true);
    expect(states.at(-1)?.hideLabels).toBe(false);
    // 阈值 0：任何倍率（含默认 1.00x 全景）都显示标签，不再要求放大
    expect(states.at(-1)?.labelZoomThreshold).toBe(0);
  });

  it('切到省级档：省级地图、不显示港澳放大框、不允许下钻，省名标签常显', () => {
    const { ctx, calls, states } = makeCtx();
    const mode = new FreeBrowseMode(ctx);
    mode.setGranularity('province');
    expect(mode.getGranularity()).toBe('province');
    expect(calls).toContain('province:true:false:false');
    expect(states.at(-1)?.showAllProvinceLabels).toBe(true);
  });

  it('切到世界档：世界地图（全世界范围），国名标签默认常显（阈值 0）', () => {
    const { ctx, calls, states } = makeCtx();
    const mode = new FreeBrowseMode(ctx);
    mode.setGranularity('world');
    expect(mode.getGranularity()).toBe('world');
    expect(calls).toContain('world:true:-:-');
    expect(states.at(-1)?.worldShowAllLabels).toBe(true);
    expect(states.at(-1)?.worldLabelZoomThreshold).toBe(0);
  });

  it('双击不下钻', () => {
    const { ctx, calls, states } = makeCtx();
    const mode = new FreeBrowseMode(ctx);
    mode.enter();
    const before = states.length;
    mode.onUnitDblClick('440000');
    expect(calls.some((c) => c.startsWith('drill:'))).toBe(false);
    expect(states.length).toBe(before);
  });

  it('「隐藏标签」把 hideLabels 传给渲染状态', () => {
    const { ctx, states } = makeCtx();
    const mode = new FreeBrowseMode(ctx);
    const panel = mode.getModeSettings();
    expect(panel?.toggles.map((t) => t.key)).toEqual(['hide-labels']);
    panel?.onChange('hide-labels', true);
    expect(states.at(-1)?.hideLabels).toBe(true);
    expect(states.at(-1)?.showAllLabels).toBe(false);
  });
});
