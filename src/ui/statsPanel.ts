import type { AppData, Unit } from '../types';
import type { MemoryStore } from '../store';
import { t } from '../i18n';
import { normalizeProvince } from '../matcher';
import { provinceLevelOf, PROVINCE_LEVEL_WORD_KEY, type ProvinceLevel } from '../modes/free';

type ProvinceStats = { mastered: number; unknown: number; unfamiliar: number };
type ProvinceLevelStats = Record<ProvinceLevel, number>;

const LEVEL_ORDER: ProvinceLevel[] = ['terrible', 'poor', 'unfamiliar', 'neutral', 'beginner', 'skilled', 'master'];

/** 侧栏：按累计答题分数展示熟练度。地级档（全国=各省行七档+进度条；单省 drill=该省摘要+进度条），省级档（各省七档词）。 */
export class StatsPanel {
  private el: HTMLElement;
  private provinceList: { adcode: string; name: string; units: Unit[] }[];

  constructor(containerId: string, data: AppData, private store: MemoryStore) {
    this.el = document.getElementById(containerId) as HTMLElement;
    const map = new Map<string, { adcode: string; name: string; units: Unit[] }>();
    for (const p of data.provinces) map.set(p.adcode, { adcode: p.adcode, name: p.name, units: [] });
    for (const u of data.units) map.get(u.provinceAdcode)?.units.push(u);
    this.provinceList = [...map.values()].filter((p) => p.units.length > 0);
  }

  /** 地级档：全国视图每省行 = 档位词（按省内分数和）+ 三态进度条；单省(drill)显示该省摘要（保留进度条）。 */
  refresh(provinceAdcode: string | null = null) {
    const activeProvince = provinceAdcode ? this.provinceList.find((p) => p.adcode === provinceAdcode) : null;
    if (activeProvince) {
      const stats = this.statsOf(activeProvince.units);
      this.el.innerHTML = this.summary(activeProvince.name, stats);
      return;
    }
    // 全国：各省行七档 + 进度条（档位按该省所有地级市分数之和；条=省内单位三态占比）
    const total: ProvinceLevelStats = { terrible: 0, poor: 0, unfamiliar: 0, neutral: 0, beginner: 0, skilled: 0, master: 0 };
    const sorted = [...this.provinceList].sort((a, b) => normalizeProvince(a.name).localeCompare(normalizeProvince(b.name), 'zh-CN'));
    const rows = sorted.map((p) => {
      const stats = this.statsOf(p.units);
      const level = provinceLevelOf(this.provinceScore(p.units));
      total[level] += 1;
      const levelRow = t('stats.provinceLevelRow', {
        name: normalizeProvince(p.name),
        levelClass: level,
        levelWord: t(PROVINCE_LEVEL_WORD_KEY[level]),
      });
      return `<div class="prov-name">${levelRow}</div>${this.bar(stats)}`;
    });
    const summaryParts = LEVEL_ORDER.map((level) => `${t(PROVINCE_LEVEL_WORD_KEY[level])}：<span class="stat-num">${total[level]}</span>`).join(' ');
    this.el.innerHTML = `<div class="stat-head">${t('stats.nationOverview')} <span class="pct">${summaryParts}</span></div>` + '<div class="prov-list">' + rows.join('') + '</div>';
  }

  /** 该省下所有地级市的累计分数之和。 */
  private provinceScore(units: Unit[]): number {
    return units.reduce((sum, unit) => sum + this.store.getPractice(unit.adcode).score, 0);
  }

  /** 省级档：全国 34 省按省熟练度七档统计 + 每省一行「省名 + 档位词」。 */
  refreshProvinceLevel() {
    this.renderLevelList(t('stats.provinceOverview'), this.provinceList.map((p) => ({
      name: normalizeProvince(p.name),
      score: this.store.getProvincePractice(p.adcode).score,
    })));
  }

  /** 通用：按 score 计算七档徽标，渲染「标题 + 七档计数概览 + 每行（名称 + 档位词）」。按名称排序显示。 */
  private renderLevelList(label: string, rows: { name: string; score: number }[]) {
    const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const total: ProvinceLevelStats = { terrible: 0, poor: 0, unfamiliar: 0, neutral: 0, beginner: 0, skilled: 0, master: 0 };
    const items = sorted.map((r) => {
      const level = provinceLevelOf(r.score);
      total[level] += 1;
      return `<div class="prov-name">${t('stats.provinceLevelRow', {
        name: r.name,
        levelClass: level,
        levelWord: t(PROVINCE_LEVEL_WORD_KEY[level]),
      })}</div>`;
    });
    const summaryParts = LEVEL_ORDER.map((level) => `${t(PROVINCE_LEVEL_WORD_KEY[level])}：<span class="stat-num">${total[level]}</span>`).join(' ');
    const head = `<div class="stat-head">${label} <span class="pct">${summaryParts}</span></div>`;
    this.el.innerHTML = head + '<div class="prov-list">' + items.join('') + '</div>';
  }

  private statsOf(units: Unit[]): ProvinceStats {
    return units.reduce<ProvinceStats>((acc, unit) => {
      const score = this.store.getPractice(unit.adcode).score;
      if (score > 0) acc.mastered += 1;
      else if (score < 0) acc.unfamiliar += 1;
      else acc.unknown += 1;
      return acc;
    }, { mastered: 0, unknown: 0, unfamiliar: 0 });
  }

  private summary(label: string, stats: ProvinceStats) {
    return `<div class="stat-head">${label} <span class="pct">${t('stats.scoreSummary', { mastered: stats.mastered, unknown: stats.unknown, unfamiliar: stats.unfamiliar })}</span></div>${this.bar(stats)}`;
  }

  private bar(stats: ProvinceStats) {
    const total = stats.mastered + stats.unknown + stats.unfamiliar;
    const positive = total ? (stats.mastered / total) * 100 : 0;
    const zero = total ? (stats.unknown / total) * 100 : 0;
    const negative = total ? (stats.unfamiliar / total) * 100 : 0;
    return `<div class="mastery-bar"><span class="mastery-positive" style="width:${positive}%"></span><span class="mastery-zero" style="width:${zero}%"></span><span class="mastery-negative" style="width:${negative}%"></span></div>`;
  }
}
