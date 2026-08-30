import { LeaderboardStore, type LeaderboardEntry, type LeaderboardMode } from '../leaderboardStore';
import { formatElapsedCentiseconds } from './format';

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
        return `<div class="leaderboard-row${medalClass}"><span class="leaderboard-rank">${rank}.</span><span class="leaderboard-user">${escapeHtml(entry.username)}</span><span class="leaderboard-time">${metaText(entry, scopeProvince)}</span></div>`;
      })
      .join('')}</div>`;
  }
}

/** 行尾信息：endless 显示金币+关卡，全国榜显示题数+时间，省级榜仅时间。 */
function metaText(entry: LeaderboardEntry, scopeProvince: string | null) {
  if (entry.mode === 'endless') {
    return `${formatCoins(entry.coins ?? 0)}￥ · 第${entry.level ?? 1}关`;
  }
  if (scopeProvince === null) {
    return `${entry.correct} 个 · ${formatElapsedCentiseconds(entry.elapsedMs)}`;
  }
  return formatElapsedCentiseconds(entry.elapsedMs);
}

function formatCoins(n: number) {
  return Math.round(n).toLocaleString('zh-CN');
}

function modeLabel(mode: LeaderboardMode) {
  if (mode === 'self') return '输入模式';
  if (mode === 'click') return '点击模式';
  return '无尽闯关';
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
