import type { Mode, UnitColor } from '../types';
import type { ModeCtx, ModeController } from './types';
import { t } from '../i18n';
import type { Granularity } from '../province';

/** 熟练度分析：按累计答题分数只读着色（地级市名称熟练度 / 省名称熟练度），不响应输入。 */
export class FreeMode implements ModeController {
  id: Mode = 'free';
  title = t('mode.free.title');
  /** 分析粒度：'city'（地级市，默认且现状）| 'province'（省级，省名熟练度分析）。 */
  private granularity: Granularity = this.loadGranularity();
  /** 省级档双击下钻到某省地级视图后，返回全国时恢复省级档。 */
  private returnToProvince = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private ctx: ModeCtx) {}

  getModeSettings() {
    return null;
  }

  getAnalysisGranularity(): Granularity {
    return this.granularity;
  }

  setAnalysisGranularity(g: Granularity) {
    if (this.granularity === g) return;
    this.granularity = g;
    this.persistGranularity();
    this.returnToProvince = false;
    this.ctx.renderer.backToNation();
    this.enter();
  }

  private analysisGranularityStorageKey() {
    return 'china-admin-analysis-granularity-v1';
  }

  private loadGranularity(): Granularity {
    try {
      const raw = localStorage.getItem(this.analysisGranularityStorageKey());
      return raw === 'province' ? 'province' : 'city'; // 默认地级（现状）
    } catch {
      return 'city';
    }
  }

  private persistGranularity() {
    try {
      localStorage.setItem(this.analysisGranularityStorageKey(), this.granularity);
    } catch {
      /* 忽略存储失败 */
    }
  }

  enter() {
    this.ctx.setHint('');
    this.refresh();
    this.unsubscribe = this.ctx.store.subscribe(() => this.refresh());
  }

  exit() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  refresh() {
    if (this.granularity === 'province') {
      // 省级熟练度分析：省级地图（无港澳放大框），四档着色（熟练绿/一般浅黄/陌生红/未知灰），
      // 不常显省名标签；悬停省面经 onUnitHover 显示卡片；双击省可下钻其地级
      this.ctx.renderer.setProvinceMode(true, { inset: false, allowDrill: true });
      if (this.ctx.renderer.currentProvince()) this.ctx.renderer.backToNation();
      this.ctx.renderer.render({
        colorOf: (adcode) => provinceColor(this.ctx.store, adcode),
        disableTooltip: true,
      });
      this.ctx.stats.refreshProvinceLevel();
      return;
    }
    // 地级熟练度分析（现状）：地级地图，按地级单位熟练度着色
    this.ctx.renderer.setProvinceMode(false, { inset: false });
    this.ctx.renderer.render({
      colorOf: (adcode) => scoreColor(this.ctx.store.getPractice(adcode).score),
      disableTooltip: true,
    });
    this.ctx.stats.refresh(this.ctx.renderer.currentProvince());
  }

  hasProgress() {
    return false;
  }

  onSubmit() {}

  onInput() {}

  onUnitClick() {
    return true;
  }

  onUnitDblClick(adcode: string) {
    // 省级档双击省：显示该省地级熟练度（切到地级档并下钻）；返回全国后恢复省级档
    if (this.granularity === 'province') {
      this.granularity = 'city';
      this.persistGranularity();
      this.returnToProvince = true;
      this.ctx.renderer.setProvinceMode(false, { inset: false });
      this.ctx.renderer.drillToProvince(adcode);
      this.ctx.renderer.render({
        colorOf: (c) => scoreColor(this.ctx.store.getPractice(c).score),
        disableTooltip: true,
      });
      this.ctx.stats.refresh(adcode);
      return;
    }
    /* 地级档保持现状：不响应双击下钻 */
  }

  /** 地图空白返回全国：若从省级档下钻而来则恢复省级档。 */
  onBackToNation() {
    if (this.granularity === 'city' && this.returnToProvince) {
      this.returnToProvince = false;
      this.granularity = 'province';
      this.persistGranularity();
    }
    this.enter();
  }
}

/** 分数 → 颜色：省级/地级熟练度共用同一套色阶（score≥1 绿阶、0 灰、负红阶）。 */
export function scoreColor(score: number): UnitColor {
  if (score >= 5) return 'scoreGreenDark';
  if (score >= 3) return 'scoreGreenMedium';
  if (score >= 1) return 'scoreGreenLight';
  if (score <= -5) return 'scoreRedDark';
  if (score <= -3) return 'scoreRedMedium';
  if (score <= -1) return 'scoreRedLight';
  return 'gray';
}

/** 省级熟练度四档着色：未知(从未答)→灰；一般(答过且正负相抵)→浅黄；熟练(正分)→绿阶；陌生(负分)→红阶。 */
export function provinceColor(store: { getProvincePractice: (adcode: string) => { score: number }; hasProvincePractice: (adcode: string) => boolean }, adcode: string): UnitColor {
  if (!store.hasProvincePractice(adcode)) return 'gray'; // 未知：从未答过
  const { score } = store.getProvincePractice(adcode);
  if (score === 0) return 'scoreNeutral'; // 一般：答过但正负相抵
  return scoreColor(score); // 熟练(正)/陌生(负)
}
