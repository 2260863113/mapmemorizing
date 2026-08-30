import { t } from '../i18n';

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(t('dom.missingElement', { id }));
  return el;
}

let toastTimer: number | null = null;
export function toast(msg: string, ms = 2400) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

export function setHint(html: string) {
  const topHost = $('top-hint');
  const bottomHost = $('mode-hint');
  const useTop = html.includes('start-panel');
  topHost.classList.toggle('start-host', useTop);
  topHost.classList.toggle('hidden', !useTop);
  topHost.innerHTML = useTop ? html : '';
  bottomHost.classList.toggle('hidden', useTop || html === '');
  bottomHost.innerHTML = useTop ? '' : html;
}

export function showTimer(remain: number | null, urgent = false) {
  const el = $('test-timer');
  if (remain === null) {
    el.classList.add('hidden');
    el.classList.remove('urgent');
    return;
  }
  el.classList.remove('hidden');
  el.textContent = `${(remain / 1000).toFixed(2)}s`;
  el.classList.toggle('urgent', urgent);
}

export function showStopwatch(elapsedMs: number | null) {
  const el = $('test-timer');
  if (elapsedMs === null) {
    el.classList.add('hidden');
    el.classList.remove('urgent');
    return;
  }
  el.classList.remove('hidden');
  el.classList.remove('urgent');
  el.textContent = `${(elapsedMs / 1000).toFixed(2)}s`;
}

export function showSummary(html: string, onRestart: () => void, onSubmit?: () => void) {
  $('summary-body').innerHTML = html;
  const submit = $('summary-submit') as HTMLButtonElement;
  submit.classList.toggle('hidden', !onSubmit);
  submit.onclick = onSubmit ?? null;
  const restart = $('summary-restart') as HTMLButtonElement;
  restart.onclick = () => {
    hideSummary();
    onRestart();
  };
  ($('summary-close') as HTMLButtonElement).onclick = hideSummary;
  $('summary').classList.remove('hidden');
}

export function hideSummary() {
  $('summary').classList.add('hidden');
}

/** 全国排行榜结算卡片：显示结算内容，提供「提交成绩」「关闭」两个选项。 */
export function showSettlement(html: string, onSubmit: () => void, onClose: () => void) {
  $('settlement-body').innerHTML = html;
  ($('settlement-submit') as HTMLButtonElement).onclick = onSubmit;
  ($('settlement-close') as HTMLButtonElement).onclick = onClose;
  $('settlement').classList.remove('hidden');
}

export function hideSettlement() {
  $('settlement').classList.add('hidden');
}

/** 无尽闯关顶部进度卡片（空字符串时隐藏）。 */
export function endlessStatus(html: string) {
  const el = $('endless-status');
  el.innerHTML = html;
  el.classList.toggle('hidden', html === '');
}

/** 无尽闯关通关卡片：屏幕中心展示，点击「继续」后进入下一关。 */
export function showLevelEnd(html: string, onContinue: () => void) {
  $('level-end-body').innerHTML = html;
  ($('level-end-continue') as HTMLButtonElement).onclick = () => {
    hideLevelEnd();
    onContinue();
  };
  $('level-end').classList.remove('hidden');
}

export function hideLevelEnd() {
  $('level-end').classList.add('hidden');
}

/** 无尽闯关惩罚：倒计时卡片闪烁变红 2 秒。 */
export function flashTimerPenalty() {
  const el = $('test-timer');
  el.classList.remove('penalty');
  void el.offsetWidth; // 强制重排以重启动画
  el.classList.add('penalty');
  window.setTimeout(() => el.classList.remove('penalty'), 2000);
}

/** 无尽闯关道具卡片（屏幕下方，空字符串时隐藏）。 */
export function endlessItems(html: string) {
  const el = $('endless-items');
  el.innerHTML = html;
  el.classList.toggle('hidden', html === '');
}

/** 无尽闯关关键字卡片（飞花令牌，空字符串时隐藏）。 */
export function endlessToken(html: string) {
  const el = $('endless-token');
  el.innerHTML = html;
  el.classList.toggle('hidden', html === '');
}

/** 无尽闯关食物卡片（美食鉴赏家，空字符串时隐藏）。 */
export function endlessFood(html: string) {
  const el = $('endless-food');
  el.innerHTML = html;
  el.classList.toggle('hidden', html === '');
}

/** 无尽闯关道具商店。 */
export function showShop() {
  $('endless-shop').classList.remove('hidden');
}

export function hideShop() {
  $('endless-shop').classList.add('hidden');
}
