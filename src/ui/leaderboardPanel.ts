import { LeaderboardStore, type LeaderboardEntry, type LeaderboardMode } from '../leaderboardStore';
import { formatElapsedCentiseconds } from './format';
import { normalize, normalizeProvince } from '../matcher';
import { avatarHtml } from './avatar';
import type { AppData } from '../types';
import { t } from '../i18n';

/** 侧栏：按当前测试模式和范围展示云端共享排行榜。 */
export class LeaderboardPanel {
  private el: HTMLElement;
  private renderSeq = 0; // 过期渲染守卫：快速连续调用时丢弃旧结果

  constructor(containerId: string, private store: LeaderboardStore, private data: AppData) {
    this.el = document.getElementById(containerId) as HTMLElement;
  }

  async refresh(mode: LeaderboardMode, scopeProvince: string | null, scopeLabel: string) {
    const seq = ++this.renderSeq;
    const title = t('leaderboard.title', { mode: modeLabel(mode), scope: scopeLabel });
    let rows: LeaderboardEntry[];
    try {
      rows = await this.store.ensure(mode, scopeProvince);
    } catch {
      if (seq === this.renderSeq) this.renderError(title);
      return;
    }
    if (seq !== this.renderSeq) return; // 已过期，丢弃
    this.render(title, rows.slice(0, 10), scopeProvince);
  }

  private render(title: string, rows: LeaderboardEntry[], scopeProvince: string | null) {
    if (!rows.length) {
      this.el.innerHTML = `<div class="leaderboard-title">${escapeHtml(title)}</div><div class="leaderboard-empty">${t('leaderboard.empty')}</div>`;
      return;
    }
    this.el.innerHTML = `<div class="leaderboard-title">${escapeHtml(title)}</div><div class="leaderboard-list">${rows
      .map((entry, index) => {
        const rank = index + 1;
        const medalClass = rank <= 3 ? ` medal-${rank}` : '';
        const loc = this.hometownText(entry.hometown);
        // 始终渲染 loc 占位：无所在地时内容为空，但保持 time 列固定在第 4 列右对齐
        const locHtml = `<span class="leaderboard-loc">${escapeHtml(loc)}</span>`;
        const avatar = avatarHtml({ username: entry.username, avatar: entry.avatar });
        // 头像与用户名之间隔一个空格
        return `<div class="leaderboard-row${medalClass}"><span class="leaderboard-rank">${rank}.</span><span class="leaderboard-user">${avatar} ${escapeHtml(entry.username)}</span>${locHtml}<span class="leaderboard-time">${metaText(entry, scopeProvince)}</span></div>`;
      })
      .join('')}</div>`;
  }

  private renderError(title: string) {
    this.el.innerHTML = `<div class="leaderboard-title">${escapeHtml(title)}</div><div class="leaderboard-empty">${t('leaderboard.loadFailed')}</div>`;
  }

  /** 所在地简名：省简名 + 市简名（如 新疆伊犁）；直辖市/特别行政区省=市时只显示一个；无 hometown 返回空。 */
  private hometownText(hometown: LeaderboardEntry['hometown']): string {
    if (!hometown) return '';
    const province = this.data.provinces.find((p) => p.adcode === hometown.provinceAdcode);
    if (!province) return '';
    const provinceShort = normalizeProvince(province.name);
    if (hometown.provinceAdcode === hometown.cityAdcode) return provinceShort;
    const city = this.data.units.find((u) => u.adcode === hometown.cityAdcode);
    if (!city) return provinceShort;
    const cityShort = normalize(city.name) || city.shortName;
    if (!cityShort || cityShort === provinceShort) return provinceShort;
    return provinceShort + cityShort;
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
