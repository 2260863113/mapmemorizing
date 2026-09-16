import { LeaderboardStore, type LeaderboardEntry, type LeaderboardMode } from '../leaderboardStore';
import { modeTitle } from '../modes/capabilities';
import { formatElapsedCentiseconds } from './format';
import { normalize, normalizeProvince } from '../matcher';
import { avatarHtml } from './avatar';
import { escapeHtml } from './html';
import type { AppData } from '../types';
import { isWorldScope } from '../province';
import { t } from '../i18n';

/** 侧栏：按当前测试模式和范围展示云端共享排行榜。 */
export class LeaderboardPanel {
  private el: HTMLElement;
  private renderSeq = 0; // 过期渲染守卫：快速连续调用时丢弃旧结果

  constructor(containerId: string, private store: LeaderboardStore, private data: AppData) {
    this.el = document.getElementById(containerId) as HTMLElement;
  }

  /**
   * 刷新侧栏（**唯一的渲染入口**）。
   *
   * 渲染策略（用户口径：到了哪个范围就尽快显示哪个范围的榜）：
   *   1. 该范围**已有快照** → 立刻按快照渲染，同时在后台重新取一次，回来再替换；
   *   2. 没有快照 → 立刻把标题换成新范围并显示「加载中」。
   * 两种情况下屏幕上都不会继续留着**上一个范围**的名单——旧实现是把上一份名单原样留在
   * 屏上直到新数据回来，范围切换不跟手、还容易把别的范围的成绩误认成当前范围的。
   *
   * `renderSeq` 是「过期渲染守卫」：只有最后一次调用有资格写 DOM，快速连续切换时先发的、
   * 后到的响应一律丢弃（这也是这条链路上唯一需要的并发保护——数据本身由 store 合并）。
   */
  async refresh(mode: LeaderboardMode, scopeProvince: string | null, scopeLabel: string) {
    const seq = ++this.renderSeq;
    const title = t('leaderboard.title', { mode: modeLabel(mode), scope: scopeLabel });
    const cached = this.store.peek(mode, scopeProvince);
    if (cached) this.render(title, cached.slice(0, 10), scopeProvince);
    else this.renderLoading(title);

    let rows: LeaderboardEntry[];
    try {
      rows = await this.store.ensure(mode, scopeProvince);
    } catch {
      if (seq !== this.renderSeq) return; // 已过期，丢弃
      // 后台刷新失败时，有快照就静默保留旧数据（把已有内容顶成错误页是净损失）。
      if (cached) this.render(title, cached.slice(0, 10), scopeProvince);
      else this.renderError(title);
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

  /** 该范围没看过时的占位：标题已经是新范围，名单位置明确写着「加载中」。 */
  private renderLoading(title: string) {
    this.el.innerHTML = `<div class="leaderboard-title">${escapeHtml(title)}</div><div class="leaderboard-empty">${t('leaderboard.loading')}</div>`;
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

/** 行尾信息：endless 显示金币+关卡；拼图显示「已拼 X/Y ｜ 用时」；全国语义榜显示题数+时间，省级榜仅时间。 */
function metaText(entry: LeaderboardEntry, scopeProvince: string | null) {
  if (entry.mode === 'endless') {
    return t('leaderboard.endlessMeta', { coins: formatCoins(entry.coins ?? 0), level: entry.level ?? 1 });
  }
  if (entry.mode === 'puzzle') {
    return t('leaderboard.puzzleMeta', {
      placed: entry.correct,
      total: entry.totalUnits,
      time: formatElapsedCentiseconds(entry.elapsedMs),
    });
  }
  // 全国语义榜（市级全国 null / 世界全国 / 大洲榜 / 次区域榜哨兵）显示题数+时间，省级榜仅时间。
  if (scopeProvince === null || isWorldScope(scopeProvince)) {
    return t('leaderboard.nationMeta', { correct: entry.correct, time: formatElapsedCentiseconds(entry.elapsedMs) });
  }
  return formatElapsedCentiseconds(entry.elapsedMs);
}

function formatCoins(n: number) {
  return Math.round(n).toLocaleString('zh-CN');
}

/**
 * 排行榜里的模式名 = 模式名本身（`mode.*.title`）—— 从前这里另有一份
 * `leaderboard.mode.*`，四段文字与模式名逐字相同却各存一处（本轮删掉，见 AI_HANDOFF）。
 */
function modeLabel(mode: LeaderboardMode) {
  return modeTitle(mode);
}
