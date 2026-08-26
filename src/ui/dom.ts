export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
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
  const host = $('mode-hint');
  host.classList.toggle('start-host', html.includes('start-panel'));
  host.innerHTML = html;
}

export function showTimer(remain: number | null, urgent = false) {
  const el = $('test-timer');
  el.classList.remove('timer-inline');
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
  el.classList.add('timer-inline');
  if (elapsedMs === null) {
    el.classList.add('hidden');
    el.classList.remove('urgent');
    return;
  }
  el.classList.remove('hidden');
  el.classList.remove('urgent');
  el.textContent = `${(elapsedMs / 1000).toFixed(2)}s`;
}

export function showSummary(html: string, onRestart: () => void) {
  $('summary-body').innerHTML = html;
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
