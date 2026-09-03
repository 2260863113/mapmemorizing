import type { Mode, UnitColor } from '../types';
import type { ModeCtx, ModeController } from './types';
import { t, type MessagesKey } from '../i18n';
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
      // 省级熟练度分析：省级地图（无港澳放大框），七档着色（糟糕/较差/陌生/一般/初识/熟练/炉火纯青），
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

/** 省级熟练度七档（从差到好）：糟糕(≤-5)/较差(-3~-4)/陌生(-1~-2)/一般(0)/初识(1~2)/熟练(3~4)/炉火纯青(≥5)。 */
export type ProvinceLevel = 'terrible' | 'poor' | 'unfamiliar' | 'neutral' | 'beginner' | 'skilled' | 'master';

/** 七档文案键。 */
export const PROVINCE_LEVEL_WORD_KEY: Record<ProvinceLevel, MessagesKey> = {
  terrible: 'stats.levelTerrible',
  poor: 'stats.levelPoor',
  unfamiliar: 'stats.levelUnfamiliar',
  neutral: 'stats.levelNeutral',
  beginner: 'stats.levelBeginner',
  skilled: 'stats.levelSkilled',
  master: 'stats.levelMaster',
};

/** 分数 → 七档档位。0 分统一为「一般」，不再区分未答与相抵。 */
export function provinceLevelOf(score: number): ProvinceLevel {
  if (score >= 5) return 'master';
  if (score >= 3) return 'skilled';
  if (score >= 1) return 'beginner';
  if (score === 0) return 'neutral';
  if (score <= -5) return 'terrible';
  if (score <= -3) return 'poor';
  return 'unfamiliar';
}

/** 七档 → 地图色（与 provinceLevelOf 同一阈值）。 */
export function provinceLevelColor(level: ProvinceLevel): UnitColor {
  if (level === 'master') return 'scoreGreenDark';
  if (level === 'skilled') return 'scoreGreenMedium';
  if (level === 'beginner') return 'scoreGreenLight';
  if (level === 'neutral') return 'scoreNeutral';
  if (level === 'terrible') return 'scoreRedDark';
  if (level === 'poor') return 'scoreRedMedium';
  return 'scoreRedLight';
}

/** 省级熟练度七档着色（按省 adcode 查熟练度）。 */
export function provinceColor(store: { getProvincePractice: (adcode: string) => { score: number } }, adcode: string): UnitColor {
  return provinceLevelColor(provinceLevelOf(store.getProvincePractice(adcode).score));
}
