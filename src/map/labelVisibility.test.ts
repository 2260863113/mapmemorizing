import { describe, it, expect, afterEach } from 'vitest';
import { labelOverride, labelsVisible, labelsVisibleWith, setLabelOverride } from './labelVisibility';

/**
 * Alt 热切换的可见性口径（2026-09 需求 6）。
 *
 * 三态是这条需求的全部语义，且必须**逐条**锁住：
 *   · 没有覆盖（null）：设置开 + 未答题 = 显示；答题进行中 = 不显示；设置关 = 永不显示；
 *   · 覆盖 true：**任何情况都显示**，包括答题进行中与设置关（这正是「热切换」的意义）；
 *   · 覆盖 false：任何情况都不显示（用户按 Alt 明确要藏起来，设置开着也不给）。
 *
 * 反例（错误实现）：把覆盖当成「与设置取反」或者「只在设置开着时才生效」——
 * 前者会让「设置关 + 覆盖 true」变成隐藏，后者让答题中的 Alt 完全失效。
 */
function reset() {
  setLabelOverride(null);
}

describe('labelsVisible（三态：无覆盖 / 强制显示 / 强制隐藏）', () => {
  afterEach(reset);

  it('无覆盖且设置开着：未答题显示、答题进行中不显示', () => {
    reset();
    expect(labelsVisible(true, false)).toBe(true);
    expect(labelsVisible(true, true)).toBe(false);
  });

  it('无覆盖且设置关掉：无论是否答题都不显示', () => {
    reset();
    expect(labelsVisible(false, false)).toBe(false);
    expect(labelsVisible(false, true)).toBe(false);
  });

  it('覆盖 = true：答题进行中也显示全量（Alt 热切换的核心）', () => {
    setLabelOverride(true);
    expect(labelsVisible(false, true)).toBe(true); // 设置关着也照样显示
    expect(labelsVisible(true, true)).toBe(true);
    expect(labelsVisible(true, false)).toBe(true);
  });

  it('覆盖 = false：设置开着也一律不显示', () => {
    setLabelOverride(false);
    expect(labelsVisible(true, false)).toBe(false);
    expect(labelsVisible(true, true)).toBe(false);
    expect(labelsVisible(false, false)).toBe(false);
  });

  it('覆盖可反复切换，且改回 null 后立刻回到设置口径（会话级、不留痕）', () => {
    setLabelOverride(true);
    expect(labelsVisible(true, true)).toBe(true);
    setLabelOverride(false);
    expect(labelsVisible(true, false)).toBe(false);
    setLabelOverride(null);
    expect(labelOverride()).toBe(null);
    expect(labelsVisible(true, false)).toBe(true);
    expect(labelsVisible(true, true)).toBe(false);
  });
});

describe('labelsVisibleWith（注入式读数，供模式侧与单测使用）', () => {
  afterEach(reset);

  it('与 labelsVisible 在同样输入下等价，但不读模块级单例', () => {
    setLabelOverride(false); // 单例是「隐藏」
    // 显式传 null：应当与单例无关，走设置口径
    expect(labelsVisibleWith(null, true, false)).toBe(true);
    expect(labelsVisibleWith(null, true, true)).toBe(false);
    expect(labelsVisible(true, false)).toBe(false); // 单例仍然生效
  });

  it('显式覆盖优先于设置与进行中状态', () => {
    expect(labelsVisibleWith(true, false, true)).toBe(true);
    expect(labelsVisibleWith(false, true, false)).toBe(false);
  });
});
