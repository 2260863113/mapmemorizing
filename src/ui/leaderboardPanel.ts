import { LeaderboardStore, type LeaderboardEntry, type LeaderboardMode } from '../leaderboardStore';
import { formatElapsedCentiseconds } from './format';
import { t } from '../i18n';

/** 侧栏：按当前测试模式和范围展示本机排行榜。 */
export class LeaderboardPanel {
  private el: HTMLElement;

  constructor(containerId: string, private store: LeaderboardStore) {
    this.el = document.getElementById(containerId) as HTMLElement;
  }

  refresh(mode: LeaderboardMode, scopeProvince: string | null, scopeLabel: string) {
    const rows = this.store.list(mode, scopeProvince).slice(0, 10);
    const title = t('leaderboard.title', { mode: modeLabel(mode), scope: scopeLabel });
    if (!rows.length) {
      this.el.innerHTML = `<div class="leaderboard-title">${escapeHtml(title)}</div><div class="leaderboard-empty">${t('leaderboard.empty')}</div>`;
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
    return t('leaderboard.endlessMeta', { coins: formatCoins(entry.coins ?? 0), level: entry.level ?? 1 });
  }
  if (scopeProvince === null) {
    return t('leaderboard.nationMeta', { correct: entry.correct, time: formatElapsedCentiseconds(entry.elapsedMs) });
  }
  return formatElapsedCentiseconds(entry.elapsedMs);
}

function formatCoins(n: number) {
  return Math.round(n).toLocaleString('zh-CN');
}

function modeLabel(mode: LeaderboardMode) {
  if (mode === 'self') return t('leaderboard.mode.self');
  if (mode === 'click') return t('leaderboard.mode.click');
  return t('leaderboard.mode.endless');
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
