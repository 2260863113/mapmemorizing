import { LeaderboardStore, type LeaderboardMode } from '../leaderboardStore';

/** 侧栏：按当前测试模式和范围展示本机排行榜。 */
export class LeaderboardPanel {
  private el: HTMLElement;

  constructor(containerId: string, private store: LeaderboardStore) {
    this.el = document.getElementById(containerId) as HTMLElement;
  }

  refresh(mode: LeaderboardMode, scopeProvince: string | null, scopeLabel: string) {
    const rows = this.store.list(mode, scopeProvince).slice(0, 10);
    const title = `${modeLabel(mode)} · ${scopeLabel}`;
    if (!rows.length) {
      this.el.innerHTML = `<div class="leaderboard-empty"><b>${escapeHtml(title)}</b><span>暂无成绩</span></div>`;
      return;
    }
    this.el.innerHTML = `<div class="leaderboard-scope">${escapeHtml(title)}</div><div class="leaderboard-list">${rows
      .map((entry, index) => {
        const rank = index + 1;
        const medal = medalLabel(index);
        const medalClass = rank <= 3 ? ` medal-${rank}` : '';
        return `<div class="leaderboard-row${medalClass}"><div class="leaderboard-rank">${medal}</div><div class="leaderboard-user">${escapeHtml(entry.username)}</div><div class="leaderboard-time">${formatElapsed(entry.elapsedMs)}</div></div>`;
      })
      .join('')}</div>`;
  }
}

function modeLabel(mode: LeaderboardMode) {
  if (mode === 'self') return '输入模式';
  if (mode === 'challenge') return '挑战模式';
  return '点击模式';
}

function medalLabel(index: number) {
  if (index === 0) return '金';
  if (index === 1) return '银';
  if (index === 2) return '铜';
  return String(index + 1);
}

function formatElapsed(elapsedMs: number) {
  const secs = Math.round(elapsedMs / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
