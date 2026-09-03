import type { AppData, Unit } from '../types';
import type { MemoryStore } from '../store';
import { t } from '../i18n';
import { normalizeProvince } from '../matcher';
import { provinceLevelOf, PROVINCE_LEVEL_WORD_KEY, type ProvinceLevel } from '../modes/free';

type ProvinceLevelStats = Record<ProvinceLevel, number>;

const LEVEL_ORDER: ProvinceLevel[] = ['terrible', 'poor', 'unfamiliar', 'neutral', 'beginner', 'skilled', 'master'];

/** 侧栏：按累计答题分数展示熟练度。支持地级（各属地级单位三态）与省级（各省七档词）两套数据源。 */
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

  /** 地级档：全国视图按省行（每省档位=该省各地级市分数之和）；单省(drill)显示省内各地级市行。均为七档徽标。 */
  refresh(provinceAdcode: string | null = null) {
    const activeProvince = provinceAdcode ? this.provinceList.find((p) => p.adcode === provinceAdcode) : null;
    if (activeProvince) {
      // 单省：列出省内各地级市单位，档位按各单位自身分数
      this.renderLevelList(activeProvince.name, activeProvince.units.map((u) => ({
        name: u.shortName,
        score: this.store.getPractice(u.adcode).score,
      })));
      return;
    }
    // 全国：每省一行，档位按该省所有地级市分数之和
    this.renderLevelList(t('stats.nationOverview'), this.provinceList.map((p) => ({
      name: normalizeProvince(p.name),
      score: this.provinceScore(p.units),
    })));
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
}
