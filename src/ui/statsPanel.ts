import type { AppData, Unit } from '../types';
import type { MemoryStore } from '../store';
import { t } from '../i18n';

type ProvinceStats = { mastered: number; unknown: number; unfamiliar: number };

/** 侧栏：按地级单位累计答题分数展示熟练度。 */
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
