import type { AppData, Unit } from '../types';
import type { MemoryStore } from '../store';

/** 侧栏：自由模式进度（总数 + 各省进度条） */
export class StatsPanel {
  private el: HTMLElement;
  private total: number;
  private provinceList: { adcode: string; name: string; units: Unit[] }[];

  constructor(containerId: string, data: AppData, private store: MemoryStore) {
    this.el = document.getElementById(containerId) as HTMLElement;
    this.total = data.units.length;
    const map = new Map<string, { adcode: string; name: string; units: Unit[] }>();
    for (const p of data.provinces) map.set(p.adcode, { adcode: p.adcode, name: p.name, units: [] });
    for (const u of data.units) {
      const p = map.get(u.provinceAdcode);
      if (p) p.units.push(u);
    }
    this.provinceList = [...map.values()].filter((p) => p.units.length > 0);
  }

  refresh() {
    const learned = this.store.learnedCount();
    const pct = this.total ? Math.round((learned / this.total) * 100) : 0;
    let html = `<div class="stat-head">已记忆 <b>${learned}</b> / ${this.total} <span class="pct">${pct}%</span></div>
      <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>`;
    html += '<div class="prov-list">' + this.provinceList.map((p) => {
      const done = p.units.filter((u) => this.store.isLearned(u.adcode)).length;
      const w = p.units.length ? Math.round((done / p.units.length) * 100) : 0;
      return `<div class="prov-name">${p.name} <span>${done}/${p.units.length}</span></div>
        <div class="bar mini"><div class="bar-fill" style="width:${w}%"></div></div>`;
    }).join('') + '</div>';
    this.el.innerHTML = html;
  }
}
