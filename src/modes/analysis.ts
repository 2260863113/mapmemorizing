import type { Continent, Mode, SubregionId, UnitColor } from '../types';
import type { ModeCtx } from './types';
import { BaseMode } from './baseMode';
import { t, type MessagesKey } from '../i18n';
import type { Granularity } from '../province';
import { hasSubregions, subregionById, subregionOfContinent, subregionOfIso } from '../subregions';
import { CONTINENTS } from '../types';

/** 大洲 id → 中文名（侧栏「地图范围」说明用）。 */
const CONTINENT_NAMES: Record<string, string> = Object.fromEntries(CONTINENTS.map((c) => [c.id, c.name]));

/** 熟练度分析：按累计答题分数只读着色（地级市/省名/国家名熟练度），不响应输入。 */
export class AnalysisMode extends BaseMode {
  id: Mode = 'free';
  title = t('mode.free.title');
  /** 分析粒度：'city'（地级市，默认且现状）| 'province'（省级，省名熟练度分析）| 'world'（世界，国家名熟练度分析）。 */
  private granularity: Granularity = this.loadGranularity();
  /** 世界档的大洲范围：null=全世界（Q21：给分析模式的世界档也加上大洲/次区域行）。 */
  private worldContinent: Continent | null = null;
  /** 世界档的次区域范围：null=全洲（必然属于 worldContinent）。 */
  private worldSubregion: SubregionId | null = null;
  /** 省级档双击下钻到某省地级视图后，返回全国时恢复省级档。 */
  private returnToProvince = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private ctx: ModeCtx) { super(); }

  getModeSettings() {
    return null;
  }

  getAnalysisGranularity(): Granularity {
    return this.granularity;
  }

  /** 通用粒度读取（供表现层经 ModeController 抽象访问，等价于 getAnalysisGranularity）。 */
  getGranularity(): Granularity {
    return this.granularity;
  }

  /** 世界档的大洲范围（null=全世界；非世界档返回 null）。 */
  getWorldContinent(): Continent | null {
    return this.granularity === 'world' ? this.worldContinent : null;
  }

  /** 世界档的次区域范围（null=全洲；非世界档或无大洲时返回 null）。 */
  getWorldSubregion(): SubregionId | null {
    if (this.granularity !== 'world' || !this.worldContinent) return null;
    return this.worldSubregion;
  }

  /** 切换世界档大洲范围（熟练度分析无「答题进行中」，故无 started 守卫）。 */
  setWorldContinent(c: Continent | null) {
    if (this.granularity !== 'world' || this.worldContinent === c) return;
    this.worldContinent = c;
    this.worldSubregion = null;
    this.enter();
  }

  /** 切换世界档次区域范围（null=全洲；需该大洲确有次区域）。 */
  setWorldSubregion(s: SubregionId | null) {
    if (this.granularity !== 'world' || !this.worldContinent) return;
    const target = s && subregionOfContinent(this.ctx.data, s) === this.worldContinent ? s : null;
    if (this.worldSubregion === target) return;
    this.worldSubregion = target;
    this.enter();
  }

  /** 当前世界范围的可读名（供侧栏「地图范围」说明用，见 Q29）。 */
  private worldScopeLabel(): string {
    if (!this.worldContinent) return t('common.world');
    const continentName = CONTINENT_NAMES[this.worldContinent] ?? t('common.world');
    if (!this.worldSubregion) return continentName;
    return subregionById(this.ctx.data, this.worldSubregion)?.name ?? continentName;
  }

  setAnalysisGranularity(g: Granularity) {
    if (this.granularity === g) return;
    this.granularity = g;
    // 离开世界档即清除大洲/次区域范围
    if (g !== 'world') {
      this.worldContinent = null;
      this.worldSubregion = null;
    }
    this.persistGranularity();
    this.returnToProvince = false;
    // 仅当处于钻省视图时先返回全国（清除钻省态并恢复钻省前全国视野）；
    // 普通全国视图的缩放/拖动位置保留，由渲染器跨世界/中国记忆槽在切回时恢复。
    if (this.ctx.renderer.currentProvince()) this.ctx.renderer.backToNation();
    this.enter();
  }

  private analysisGranularityStorageKey() {
    return 'china-admin-analysis-granularity-v1';
  }

  private loadGranularity(): Granularity {
    try {
      const raw = localStorage.getItem(this.analysisGranularityStorageKey());
      if (raw === 'province') return 'province';
      if (raw === 'world') return 'world';
      return 'city'; // 默认地级（现状）
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
    this.unsubscribe?.(); // 重复 enter（如切换分析粒度）前先解绑，避免订阅累积
    this.ctx.setHint('');
    this.refresh();
    this.unsubscribe = this.ctx.store.subscribe(() => this.refresh());
  }

  exit() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  refresh() {
    if (this.granularity === 'world') {
      // 世界熟练度分析：世界地图，七档着色（同一套 scoreColor 阈值），
      // 不常显国名标签（放大过阈值后经渲染器显示）；悬停国家经 onUnitHover 显示卡片；
      // 大洲/次区域范围非空时聚焦并只渲染该范围（Q21）。
      this.ctx.renderer.setWorldMode(true, this.worldContinent, this.worldSubregion);
      this.ctx.renderer.render({
        colorOf: (iso) => worldColor(this.ctx.store, iso),
        disableTooltip: true,
        worldShowAllLabels: true,
      });
      // 侧栏聚合仍统计全世界（国家熟练度是共享分区），只加一行「地图范围」说明（Q29）
      this.ctx.stats.refreshWorldLevel(this.worldScopeLabel());
      return;
    }
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

  onUnitClick() {
    return true;
  }

  onUnitDblClick(adcode: string) {
    // 世界档双击国家：逐层下钻（世界→大洲→次区域），与地图测验模式同一套语义（Q12/Q21）
    if (this.granularity === 'world') {
      const c = this.ctx.data.countries.find((x) => x.iso === adcode);
      if (!c) return;
      if (this.worldContinent !== c.continent) {
        this.worldContinent = c.continent;
        this.worldSubregion = null;
        this.enter();
        return;
      }
      if (!hasSubregions(this.ctx.data, c.continent)) return;
      const sr = subregionOfIso(this.ctx.data, adcode);
      if (!sr || this.worldSubregion === sr) return;
      this.worldSubregion = sr;
      this.enter();
      return;
    }
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

  /**
   * 地图空白返回：世界档退一级（次区域 → 大洲 → 世界，Q13）；
   * 若从省级档下钻而来则恢复省级档。熟练度分析无「答题进行中」，故不拦截。
   */
  onBackToNation() {
    if (this.granularity === 'world') {
      if (this.worldSubregion) this.worldSubregion = null;
      else if (this.worldContinent) this.worldContinent = null;
      else return; // 已在世界层，无上级可退
      this.enter();
      return;
    }
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

/** 七档 → 地图色（与 provinceLevelOf 同一阈值）。0 分(一般)沿用地图灰色系，与地级档 0 分同色。 */
export function provinceLevelColor(level: ProvinceLevel): UnitColor {
  if (level === 'master') return 'scoreGreenDark';
  if (level === 'skilled') return 'scoreGreenMedium';
  if (level === 'beginner') return 'scoreGreenLight';
  if (level === 'neutral') return 'gray';
  if (level === 'terrible') return 'scoreRedDark';
  if (level === 'poor') return 'scoreRedMedium';
  return 'scoreRedLight';
}

/** 省级熟练度七档着色（按省 adcode 查熟练度）。 */
export function provinceColor(store: { getProvincePractice: (adcode: string) => { score: number } }, adcode: string): UnitColor {
  return provinceLevelColor(provinceLevelOf(store.getProvincePractice(adcode).score));
}

/** 国家熟练度七档着色（按 iso 查国家熟练度；阈值与省/地级同一套）。 */
export function worldColor(store: { getWorldPractice: (iso: string) => { score: number } }, iso: string): UnitColor {
  return provinceLevelColor(provinceLevelOf(store.getWorldPractice(iso).score));
}
