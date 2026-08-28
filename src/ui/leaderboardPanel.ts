import { LeaderboardStore, type LeaderboardMode } from '../leaderboardStore';

/** 侧栏：按当前测试模式和范围展示本机排行榜。 */
export class LeaderboardPanel {
  private el: HTMLElement;

  constructor(containerId: string, private store: LeaderboardStore) {
    this.el = document.getElementById(containerId) as HTMLElement;
  }

  refresh(mode: LeaderboardMode, scopeProvince: string | null, scopeLabel: string) {
    const rows = this.store.list(mode, scopeProvince).slice(0, 10);
    const title = `${modeLabel(mode)} ${scopeLabel}排行榜`;
    if (!rows.length) {
      this.el.innerHTML = `<div class="leaderboard-title">${escapeHtml(title)}</div><div class="leaderboard-empty">暂无成绩</div>`;
      return;
    }
    this.el.innerHTML = `<div class="leaderboard-title">${escapeHtml(title)}</div><div class="leaderboard-list">${rows
      .map((entry, index) => {
        const rank = index + 1;
        const medalClass = rank <= 3 ? ` medal-${rank}` : '';
        return `<div class="leaderboard-row${medalClass}"><span class="leaderboard-rank">${rank}.</span><span class="leaderboard-user">${escapeHtml(entry.username)}</span><span class="leaderboard-time">${formatElapsed(entry.elapsedMs)}</span></div>`;
      })
      .join('')}</div>`;
  }
}

function modeLabel(mode: LeaderboardMode) {
  if (mode === 'self') return '输入模式';
  if (mode === 'challenge') return '挑战模式';
  return '点击模式';
}

function formatElapsed(elapsedMs: number) {
  const centis = Math.round(elapsedMs / 10);
  const mm = String(Math.floor(centis / 6000)).padStart(2, '0');
  const ss = String(Math.floor((centis % 6000) / 100)).padStart(2, '0');
  const cc = String(centis % 100).padStart(2, '0');
  return `${mm}:${ss}.${cc}`;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
