import type { Mode } from '../types';
import type { ModeCtx, ModeController } from './types';

/**
 * 自由模式：点击区域或输入地名（回车确认）标记绿色；无时间限制、无固定顺序。
 * 匹配规则（无下拉联想）：地级单位优先（含简称/去限定词/错别字容错）；
 * 未命中地级但命中省名 → 下钻该省。
 */
export class FreeMode implements ModeController {
  id: Mode = 'free';
  title = '自由模式';
  private unsubscribe: (() => void) | null = null;

  constructor(private ctx: ModeCtx) {}

  enter() {
    this.ctx.search.setPlaceholder(this.ctx.settings.requireEnter ? '输入地名，如：黔南（回车确认）' : '输入地名，如：黔南');
    this.ctx.setHint('');
    this.refresh();
    this.unsubscribe = this.ctx.store.subscribe(() => this.refresh());
  }

  exit() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  refresh() {
    this.ctx.renderer.render({
      colorOf: (adcode) => (this.ctx.store.isLearned(adcode) ? 'green' : 'gray'),
    });
    this.ctx.stats.refresh();
  }

  hasProgress() {
    return false;
  }

  onSubmit(v: string) {
    this.submit(v, true);
  }

  onInput(v: string) {
    this.submit(v, false);
  }

  onUnitClick(adcode: string) {
    const u = this.ctx.byAdcode.get(adcode);
    if (!u) return;
    const learned = this.ctx.store.isLearned(adcode);
    this.ctx.store.mark(adcode, !learned);
    if (!learned) this.ctx.renderer.flash(adcode);
    this.ctx.toast(learned ? `已取消记忆：${u.name}` : `已记忆：${u.name}`);
  }

  onUnitDblClick(adcode: string) {
    const u = this.ctx.byAdcode.get(adcode);
    if (u) this.ctx.renderer.drillToProvince(u.provinceAdcode);
  }

  private submit(v: string, reportMiss: boolean) {
    const input = v.trim();
    if (!input) return;
    const unit = this.ctx.matcher.bestUnit(input);
    if (unit) {
      this.markUnit(unit.adcode);
      return;
    }
    const prov = this.ctx.matcher.bestProvince(input);
    if (prov) {
      this.ctx.renderer.drillToProvince(prov.adcode);
      this.ctx.toast(`已进入 ${prov.name}，双击地图可返回全国`);
      this.ctx.search.clear();
      return;
    }
    if (reportMiss) {
      this.ctx.toast(`未找到「${input}」，试试简称如「黔南」，或输入「贵州省」进入该省`);
      this.ctx.search.clear();
    }
  }

  private markUnit(adcode: string) {
    const u = this.ctx.byAdcode.get(adcode);
    if (!u) return;
    if (this.ctx.store.isLearned(adcode)) {
      this.ctx.toast(`「${u.name}」已记忆过`);
      this.ctx.search.clear();
      return;
    }
    this.ctx.store.mark(adcode, true);
    if (this.ctx.settings.autoFollow) this.ctx.renderer.focusUnit(adcode, this.ctx.settings.followZoom);
    this.ctx.renderer.flash(adcode);
    this.ctx.toast(`已记忆：${u.name}`);
    this.ctx.search.clear();
  }
}
