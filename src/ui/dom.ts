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

/**
 * 开始卡片：输入 / 点击 / 无尽 / 拼图四个模式共用的「标题 + 副标题 + 开始按钮」骨架。
 *
 * 原先四个模式各抄一份逐字相同的 HTML 与接线，其中三份还用 `setTimeout(…, 0)` 去取按钮 ——
 * 但 `setHint` 是**同步**写 innerHTML 的，那个延时纯属多余（白多一个宏任务，也让
 * 「点开始没反应」这类缺陷更难查）。ID 仍由调用方给，各模式沿用既有的 `#<mode>-start`。
 */
export function showStartCard(opts: { id: string; title: string; subtitle: string; onStart: () => void }) {
  setHint(
    '<div class="start-panel">' +
      `<div class="start-title">${opts.title}</div>` +
      `<div class="start-subtitle">${opts.subtitle}</div>` +
      `<button id="${opts.id}" class="start-action">${t('common.start')}</button>` +
      '</div>',
  );
  const btn = document.getElementById(opts.id) as HTMLButtonElement | null;
  if (btn) btn.onclick = () => opts.onStart();
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

export function showSummary(html: string, onRestart: () => void, onSubmit?: () => void, restartLabel?: string) {
  $('summary-body').innerHTML = html;
  const submit = $('summary-submit') as HTMLButtonElement;
  submit.classList.toggle('hidden', !onSubmit);
  submit.onclick = onSubmit ?? null;
  const restart = $('summary-restart') as HTMLButtonElement;
  restart.textContent = restartLabel ?? t('summary.restart');
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

/** 拼图模式顶部进度行（空字符串时隐藏）。 */
export function puzzleStatus(html: string) {
  const el = $('puzzle-status');
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
