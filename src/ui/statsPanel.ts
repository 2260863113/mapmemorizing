import type { AppData, Unit } from '../types';
import type { MemoryStore } from '../store';
import { t } from '../i18n';
import { normalizeProvince } from '../matcher';

type ProvinceStats = { mastered: number; unknown: number; unfamiliar: number };

/** 侧栏：按累计答题分数展示熟练度。支持地级（各属地级单位三态）与省级（各省三态）两套数据源。 */
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

  /** 地级档：全国按省汇总 + 各省行；单省（provinceAdcode 传入）只显示该省汇总。 */
  refresh(provinceAdcode: string | null = null) {
    const activeProvince = provinceAdcode ? this.provinceList.find((p) => p.adcode === provinceAdcode) : null;
    if (activeProvince) {
      const stats = this.statsOf(activeProvince.units);
      this.el.innerHTML = this.summary(activeProvince.name, stats);
      return;
    }
    const allUnits = this.provinceList.flatMap((p) => p.units);
    const total = this.statsOf(allUnits);
    let html = this.summary(t('stats.nationOverview'), total);
    html += '<div class="prov-list">' + this.provinceList.map((p) => {
      const stats = this.statsOf(p.units);
      return `<div class="prov-name">${t('stats.provinceRow', { name: p.name, mastered: stats.mastered, unknown: stats.unknown, unfamiliar: stats.unfamiliar })}</div>${this.bar(stats)}`;
    }).join('') + '</div>';
    this.el.innerHTML = html;
  }

  /** 省级档：全国 34 省按省熟练度三态统计 + 各省行。 */
  refreshProvinceLevel() {
    const provinces = [...this.provinceList].sort((a, b) => normalizeProvince(a.name).localeCompare(normalizeProvince(b.name), 'zh-CN'));
    const rows = provinces.map((p) => {
      const score = this.store.getProvincePractice(p.adcode).score;
      const stats: ProvinceStats = { mastered: score > 0 ? 1 : 0, unknown: score === 0 ? 1 : 0, unfamiliar: score < 0 ? 1 : 0 };
      return `<div class="prov-name">${t('stats.provinceRow', { name: normalizeProvince(p.name), mastered: stats.mastered, unknown: stats.unknown, unfamiliar: stats.unfamiliar })}</div>${this.bar(stats)}`;
    });
    const scoreKey = (adcode: string) => this.store.getProvincePractice(adcode).score;
    const total: ProvinceStats = {
      mastered: provinces.filter((p) => scoreKey(p.adcode) > 0).length,
      unknown: provinces.filter((p) => scoreKey(p.adcode) === 0).length,
      unfamiliar: provinces.filter((p) => scoreKey(p.adcode) < 0).length,
    };
    this.el.innerHTML = this.summary(t('stats.provinceOverview'), total) + '<div class="prov-list">' + rows.join('') + '</div>';
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
