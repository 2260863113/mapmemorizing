import type { AuthStore } from '../authStore';
import type { AnnouncementStore } from '../announcementStore';
import type { AccessLogEntry, AccessStats, AdminUser, PlayLogEntry } from '../api';
import { api } from '../api';
import { avatarHtml } from './avatar';
import { escapeAttr, escapeHtml } from './html';
import { formatDate, formatDateTime } from './dateFormat';
import { normalizeProvince } from '../matcher';
import type { AppData, Settings } from '../types';
import { t, type MessagesKey } from '../i18n';
import { TrafficChart } from './trafficChart';
import type { AdminPanelDiagnostics } from './adminPanelDiagnostics';
import {
  botReasonLabels,
  clientEnvRows,
  formatIpCell,
  formatUa,
  isAnonymous,
  isBotEntry,
  logUserName,
  MISSING,
  playModeLabel,
  playSourceLabel,
  playUserName,
  showsBotLabel,
} from './accessLog';
import {
  DEFAULT_TRAFFIC_RANGE,
  isEmptyTraffic,
  normalizeTrafficPoints,
  normalizeTrafficRange,
  normalizeTrafficUnit,
  trafficRangeSpec,
  trafficUnitKey,
  TRAFFIC_RANGES,
  type TooltipTextFn,
  type TrafficPoint,
  type TrafficRange,
  type TrafficUnit,
} from './trafficSeries';

export type AdminView = 'users' | 'logs' | 'plays' | 'announcements';

const MAX_TITLE = 60;
const MAX_CONTENT = 2000;
/** 服务端一页的条目数（分页游标用最后一条的 id；不足一页即到底）。 */
const PAGE_SIZE = 50;

/**
 * 折线看板子视图的规格：**日志记录与游玩统计逐字同构**，只有 容器 id / 文案 / 数据源 / tooltip 口径不同。
 *
 * 为什么做成规格对象而不是写两份渲染：两个视图的 DOM 结构、范围按钮行为、空态、分页逻辑完全一致，
 * 抄第二份的唯一结果是"改了一个忘了另一个" —— 本轮之前的 `truncateUa()` 就是这么漂的（首屏与
 * 「加载更多」各抄了一份 `.log-row` 模板，其中一份还带着截断）。
 *
 * id 约定：logs 沿用 `admin-traffic*`（既有验收脚本 `scripts/verify-admin-traffic.mjs` 依赖这三个 id）；
 * plays 另开一组 `admin-plays*`，否则同一时刻两个视图的 id 含义会重叠。
 */
interface BoardSpec {
  /** 图表容器 id（ECharts 挂这里；也是探针读像素的基准）。 */
  chartId: string;
  /** 范围分段按钮容器 id。 */
  rangeId: string;
  /** 粒度提示 id。 */
  unitId: string;
  /** 图表空态 id。 */
  emptyId: string;
  /** 条目列表容器 id / class。 */
  listId: string;
  listClass: string;
  /** 「加载更多」按钮 id。 */
  moreId: string;
  /** 段落标题：统计区 / 明细区。 */
  statsTitleKey: MessagesKey;
  listTitleKey: MessagesKey;
  /** 统计空态 / 明细空态文案键。 */
  emptyStatsKey: MessagesKey;
  emptyListKey: MessagesKey;
  /** tooltip 口径（缺省 = 访问量 `admin.trafficTooltip`）。 */
  tooltipText?: TooltipTextFn;
  /** 拉统计序列（同一形状的两个接口）。 */
  fetchStats: (token: string, range: TrafficRange) => Promise<AccessStats>;
}

/** 游玩看板的 tooltip 口径：量词换成「次游玩」。 */
const PLAY_TOOLTIP: TooltipTextFn = (label, count) => t('admin.playTooltip', { label, count });

/** 日志记录视图（流量看板）：既有 id 与语义**保持不变**。 */
const TRAFFIC_BOARD: BoardSpec = {
  chartId: 'admin-traffic',
  rangeId: 'admin-traffic-range',
  unitId: 'admin-traffic-unit',
  emptyId: 'admin-traffic-empty',
  listId: 'admin-log-list',
  listClass: 'admin-log-list',
  moreId: 'admin-log-more',
  statsTitleKey: 'admin.statsTitle',
  listTitleKey: 'admin.logsTitle',
  emptyStatsKey: 'admin.noStats',
  emptyListKey: 'admin.noLogs',
  fetchStats: (token, range) => api.adminStats(token, range),
};

/** 游玩统计视图：结构与日志逐字同构，换一组 id、换成游玩量口径。 */
const PLAYS_BOARD: BoardSpec = {
  chartId: 'admin-plays',
  rangeId: 'admin-plays-range',
  unitId: 'admin-plays-unit',
  emptyId: 'admin-plays-empty',
  listId: 'admin-play-list',
  listClass: 'admin-log-list admin-play-list',
  moreId: 'admin-play-more',
  statsTitleKey: 'admin.playStatsTitle',
  listTitleKey: 'admin.playsTitle',
  emptyStatsKey: 'admin.noPlayStats',
  emptyListKey: 'admin.noPlays',
  tooltipText: PLAY_TOOLTIP,
  fetchStats: (token, range) => api.adminPlayStats(token, range),
};

/** 一页数据的通用形状：分页游标是最后一条的 id。 */
interface Page<T> {
  items: T[];
}

/** 管理员面板：用户管理 / 日志记录 / 游玩统计 / 公告管理 四个子视图，主区切换。 */
export class AdminPanel {
  private el: HTMLElement;
  private view: AdminView = 'users';
  private editingAnnouncementId: number | null = null;
  /** 折线看板当前范围（会话内记忆；切换子视图后保留，避免每次都跳回默认）。日志与游玩共用。 */
  private trafficRange: TrafficRange = DEFAULT_TRAFFIC_RANGE;
  /** 折线图实例：**必须在重建 `#admin-body` 之前销毁**（见 `./trafficChart.ts` 的说明）。 */
  private traffic: TrafficChart | null = null;
  /** 最近一次画出的点序列与粒度：主题切换时用原数据重上色，不重新请求。 */
  private trafficPoints: TrafficPoint[] | null = null;
  private trafficUnit: TrafficUnit = 'day';
  /** 当前看板的 tooltip 口径：主题切换重画时要沿用（不能退回访问量口径）。 */
  private tooltipText: TooltipTextFn | undefined = undefined;

  constructor(
    containerId: string,
    private auth: AuthStore,
    private announcements: AnnouncementStore,
    private data: AppData,
    private settings: Settings,
  ) {
    this.el = document.getElementById(containerId) as HTMLElement;
  }

  show(view: AdminView = 'users') {
    this.view = view;
    this.editingAnnouncementId = null;
    this.el.classList.remove('hidden');
    this.render();
  }

  hide() {
    this.el.classList.add('hidden');
  }

  private token(): string | null {
    return this.auth.sessionToken();
  }

  /**
   * 主题切换后重上色（暗色模式的 tooltip 三色取自 `MAP_THEMES`，必须在切换后重画一次）。
   * 数据不变，故不重新请求；图表没挂载时是空操作。
   * `tooltipText` 必须一起带上：游玩看板的量词不能因为切了一次主题就退回「次访问」。
   */
  applyTheme() {
    if (!this.traffic || !this.trafficPoints) return;
    this.traffic.render(this.trafficPoints, this.trafficUnit, this.settings.darkMode, this.tooltipText);
  }

  /**
   * 销毁流量图实例。**重建 `#admin-body` 之前必须调用**：容器元素会被 innerHTML 换掉，
   * 不销毁就等于把 ECharts 实例与它的 canvas 一起丢掉（切几次 tab 泄漏几个）。
   */
  private disposeTraffic() {
    this.traffic?.dispose();
    this.traffic = null;
    this.trafficPoints = null;
    this.tooltipText = undefined;
  }

  /**
   * 验收探针的**只读**诊断视图（见 `./adminPanelDiagnostics.ts` 的说明）。
   * 生产路径不调用（只有 URL 带 `?probe=1` 时探针取一次）。
   *
   * 两套读数（`traffic*` / `plays*`）读的是**同一个实例**：任一时刻只挂一个看板。因此每个读数都
   * 先看"当前是不是我这个子视图" —— 不在本视图时返回空值，`trafficCanvasCount` 也按**容器**里真实的
   * canvas 数计（而不是问实例"你有几个 canvas"）。这样 `traffic*` 的名字与语义与加游玩统计之前
   * 完全一致（它只描述日志看板），`plays*` 也不至于把日志看板的数据读成游玩数据。
   */
  diagnostics(): AdminPanelDiagnostics {
    const self = this;
    const inLogs = () => self.view === 'logs';
    const inPlays = () => self.view === 'plays';
    const canvasCountIn = (id: string) => self.element(id)?.querySelectorAll('canvas').length ?? 0;
    const rectOf = (id: string) => {
      const rect = self.element(id)?.getBoundingClientRect();
      return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
    };
    const pixelOf = (id: string, index: number) => {
      const point = self.trafficPoints?.[index];
      if (!point || !self.traffic) return null;
      const pixel = self.traffic.pointPixel(index, point.count);
      const rect = self.element(id)?.getBoundingClientRect();
      if (!pixel || !rect) return null;
      return [rect.left + pixel[0], rect.top + pixel[1]] as [number, number];
    };
    return {
      get view() { return self.view; },
      get trafficRange() { return self.trafficRange; },
      get trafficMounted() { return inLogs() && self.traffic?.mounted === true; },
      get trafficUnit() { return inLogs() ? self.trafficUnit : 'day'; },
      get trafficPointCount() { return inLogs() ? self.trafficPoints?.length ?? 0 : 0; },
      get trafficCounts() { return inLogs() ? (self.trafficPoints ?? []).map((p) => p.count) : []; },
      get trafficLabels() { return inLogs() ? (self.trafficPoints ?? []).map((p) => p.label) : []; },
      trafficCanvasCount: () => (inLogs() ? canvasCountIn('#admin-traffic') : 0),
      trafficHeight: () => (inLogs() ? self.element('#admin-traffic')?.clientHeight ?? 0 : 0),
      trafficReadback: () => (inLogs() ? self.traffic?.readback() ?? null : null),
      /** 第 index 个数据点在**页面坐标**下的像素位置（脚本据此派发真实鼠标事件）。 */
      trafficPointClientPixel: (index) => (inLogs() ? pixelOf('#admin-traffic', index) : null),
      /** 图表容器在页面坐标下的矩形（脚本用来判断鼠标落点是否在图上）。 */
      trafficRect: () => (inLogs() ? rectOf('#admin-traffic') : null),
      /** 空态文案元素当前是否可见。 */
      get trafficEmptyVisible() {
        if (!inLogs()) return false;
        const el = self.element('#admin-traffic-empty');
        return !!el && !el.classList.contains('hidden');
      },

      // ---------- 游玩统计子视图的等价读数（同一实例，容器换成 #admin-plays） ----------
      get playsMounted() { return inPlays() && self.traffic?.mounted === true; },
      get playsUnit() { return inPlays() ? self.trafficUnit : 'day'; },
      get playsPointCount() { return inPlays() ? self.trafficPoints?.length ?? 0 : 0; },
      get playsCounts() { return inPlays() ? (self.trafficPoints ?? []).map((p) => p.count) : []; },
      get playsLabels() { return inPlays() ? (self.trafficPoints ?? []).map((p) => p.label) : []; },
      playsCanvasCount: () => (inPlays() ? canvasCountIn('#admin-plays') : 0),
      playsHeight: () => (inPlays() ? self.element('#admin-plays')?.clientHeight ?? 0 : 0),
      playsReadback: () => (inPlays() ? self.traffic?.readback() ?? null : null),
      playsPointClientPixel: (index) => (inPlays() ? pixelOf('#admin-plays', index) : null),
      playsRect: () => (inPlays() ? rectOf('#admin-plays') : null),
      get playsEmptyVisible() {
        if (!inPlays()) return false;
        const el = self.element('#admin-plays-empty');
        return !!el && !el.classList.contains('hidden');
      },
    };
  }

  private element(selector: string): HTMLElement | null {
    return this.el.querySelector<HTMLElement>(selector);
  }

  private render() {
    this.disposeTraffic(); // 下面这行会换掉整个面板的 DOM（含图表容器）
    const tabs = (['users', 'logs', 'plays', 'announcements'] as AdminView[])
      .map((v) => `<button class="admin-tab${v === this.view ? ' active' : ''}" data-view="${v}" type="button">${adminTabLabel(v)}</button>`)
      .join('');
    this.el.innerHTML = `
      <div class="admin-container">
        <h2 class="admin-heading">${t('admin.title')}</h2>
        <div class="admin-tabs">${tabs}</div>
        <div id="admin-body" class="admin-body"></div>
      </div>
    `;
    this.el.querySelectorAll<HTMLButtonElement>('.admin-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.view = btn.dataset.view as AdminView;
        this.editingAnnouncementId = null;
        this.render();
      });
    });
    void this.renderBody();
  }

  private async renderBody() {
    const body = document.getElementById('admin-body');
    if (!body) return;
    this.disposeTraffic(); // 同理：下面的 innerHTML 会换掉图表容器
    body.innerHTML = `<div class="admin-loading">${t('admin.loading')}</div>`;
    try {
      if (this.view === 'users') await this.renderUsers(body);
      else if (this.view === 'logs') await this.renderLogs(body);
      else if (this.view === 'plays') await this.renderPlays(body);
      else await this.renderAnnouncements(body);
    } catch {
      body.innerHTML = `<div class="admin-empty">${t('admin.loadFailed')}</div>`;
    }
  }

  // ---------- 用户管理 ----------

  private async renderUsers(body: HTMLElement) {
    const token = this.token();
    if (!token) throw new Error('no token');
    const res = await api.adminUsers(token);
    // 顺序**原样采用服务端**（`ORDER BY is_admin DESC, created_at DESC`：管理员置顶、越晚注册越靠前）。
    // 为什么不在前端再排一遍：排序规则只有一处才不会被两端的差异绊住（后端加了置顶口径而前端不知道，
    // 客户端排序就会把它盖掉）；页面也不再分页，服务端返回的顺序就是最终呈现顺序。
    body.innerHTML = `<div class="admin-user-list">${res.users.map((u) => this.userRow(u)).join('')}</div>`;
  }

  private userRow(user: AdminUser): string {
    const loc = this.hometownShort(user);
    return `
      <div class="admin-user-row">
        ${avatarHtml({ username: user.username, avatar: user.avatar })}
        <span class="admin-user-name">${escapeHtml(user.username)}</span>
        ${loc ? `<span class="admin-user-loc">${escapeHtml(loc)}</span>` : ''}
        <span class="admin-user-date">${formatDate(user.createdAt)}</span>
        ${user.isAdmin ? `<span class="admin-badge-admin">${t('admin.roleAdmin')}</span>` : ''}
      </div>
    `;
  }

  private hometownShort(user: AdminUser): string {
    if (!user.hometown) return '';
    const province = this.data.provinces.find((p) => p.adcode === user.hometown!.provinceAdcode);
    if (!province) return '';
    const provShort = normalizeProvince(province.name);
    if (user.hometown!.provinceAdcode === user.hometown!.cityAdcode) return provShort;
    const city = this.data.units.find((u) => u.adcode === user.hometown!.cityAdcode);
    if (!city) return provShort;
    const cityShort = city.shortName;
    if (!cityShort || cityShort === provShort) return provShort;
    return provShort + cityShort;
  }

  // ---------- 日志记录 / 游玩统计（同一套折线看板 + 条目列表） ----------

  /**
   * 日志记录视图：**流量折线图（+ 范围选择）** + 访问明细列表。
   *
   * 布局口径：折线图仍然放在这个子视图里、不新开段落；三个范围按钮与项目既有分段按钮同一套样式
   * （`.mode-segmented`），点击只**局部刷新图表**（见 `selectRange`：不重建 `#admin-body`，
   * 因此不会丢滚动位置、也不会闪一下）。
   */
  private async renderLogs(body: HTMLElement) {
    const token = this.token();
    if (!token) throw new Error('no token');
    const [stats, page] = await Promise.all([api.adminStats(token, this.trafficRange), api.adminLogs(token)]);
    const logs = page.logs;
    this.mountBoard(body, TRAFFIC_BOARD, stats, this.logRowsHtml(logs));
    this.bindMore<AccessLogEntry>(
      body,
      TRAFFIC_BOARD,
      token,
      logs,
      (before) => api.adminLogs(token, before).then((r) => ({ items: r.logs })),
      (l) => this.logRowHtml(l),
    );
  }

  /**
   * 游玩统计视图：结构与日志记录**逐字同构**（同一套范围按钮、同一个 TrafficChart、同一套空态与
   * 「加载更多」），只是数据源换成 `/api/admin/plays`，条目字段换成 时间 / 用户 / 模式 / 来源。
   * 统计口径包含 Tab 触发的重开（后端 `play_logs.source='tab'` 也计入），来源标签在条目里区分。
   */
  private async renderPlays(body: HTMLElement) {
    const token = this.token();
    if (!token) throw new Error('no token');
    const [stats, page] = await Promise.all([api.adminPlayStats(token, this.trafficRange), api.adminPlays(token)]);
    const plays = page.plays;
    this.mountBoard(body, PLAYS_BOARD, stats, this.playRowsHtml(plays));
    this.bindMore<PlayLogEntry>(
      body,
      PLAYS_BOARD,
      token,
      plays,
      (before) => api.adminPlays(token, before).then((r) => ({ items: r.plays })),
      (p) => this.playRowHtml(p),
    );
  }

  /**
   * 装配「折线看板 + 条目列表」这一整段（两个子视图逐字同构，只有 id / 文案 / tooltip 口径不同）。
   *
   * 为什么收敛到一处：DOM 结构、范围按钮行为、粒度提示、空态完全一致，抄第二份的唯一结果是
   * "改一个忘一个"。id 由 `BoardSpec` 给出，故 logs 的既有 id 一个都没变。
   */
  private mountBoard(body: HTMLElement, spec: BoardSpec, stats: AccessStats, rowsHtml: string) {
    const listHtml = rowsHtml || `<div class="admin-empty">${t(spec.emptyListKey)}</div>`;
    body.innerHTML = `
      <div class="admin-section-title">${t(spec.statsTitleKey)}</div>
      <div class="admin-traffic">
        <div class="admin-traffic-head">
          <div class="mode-segmented" id="${spec.rangeId}">${this.rangeButtonsHtml()}</div>
          <span class="admin-traffic-unit" id="${spec.unitId}"></span>
        </div>
        <div class="admin-traffic-chart" id="${spec.chartId}"></div>
        <div class="admin-traffic-empty admin-empty hidden" id="${spec.emptyId}">${t(spec.emptyStatsKey)}</div>
      </div>
      <div class="admin-section-title">${t(spec.listTitleKey)}</div>
      <div class="${spec.listClass}" id="${spec.listId}">${listHtml}</div>
      <button id="${spec.moreId}" class="board-load-more" type="button">${t('admin.loadMore')}</button>
    `;

    const chartEl = body.querySelector<HTMLElement>(`#${spec.chartId}`);
    if (chartEl) {
      this.traffic = new TrafficChart(chartEl);
      this.tooltipText = spec.tooltipText;
      this.drawBoard(spec, stats);
    }
    // 范围按钮：只切 active 与图表，不重建面板 DOM
    body.querySelectorAll<HTMLButtonElement>(`#${spec.rangeId} button`).forEach((btn) => {
      btn.addEventListener('click', () => void this.selectRange(spec, normalizeTrafficRange(btn.dataset.range)));
    });
  }

  /** 三个范围按钮（当前范围带 `active`）；日志与游玩共用同一个范围状态。 */
  private rangeButtonsHtml(): string {
    return TRAFFIC_RANGES.map((range) => {
      const cls = range === this.trafficRange ? ' class="active"' : '';
      return `<button type="button"${cls} data-range="${range}">${t(trafficRangeSpec(range).labelKey)}</button>`;
    }).join('');
  }

  /** 画一次图 + 同步粒度提示与空态（数据来自服务端，`unit` 以服务端为准）。 */
  private drawBoard(spec: BoardSpec, stats: AccessStats) {
    const points = normalizeTrafficPoints(stats.points);
    this.trafficPoints = points;
    this.trafficUnit = normalizeTrafficUnit(stats.unit);
    this.traffic?.render(points, this.trafficUnit, this.settings.darkMode, spec.tooltipText);

    const unitEl = this.el.querySelector<HTMLElement>(`#${spec.unitId}`);
    if (unitEl) unitEl.textContent = t(trafficUnitKey(this.trafficUnit));
    this.el.querySelector<HTMLElement>(`#${spec.emptyId}`)?.classList.toggle('hidden', !isEmptyTraffic(points));
  }

  /**
   * 切范围：**只**刷新图表（不重建 `#admin-body`）。
   *
   * 为什么不做整页重渲染：那会把条目列表与滚动位置一起清掉，用户每切一次范围就被弹回顶部
   * （而且图表会先消失再出现）。这里只改按钮的 active 类与图表内容。
   * 两个看板共用 `trafficRange`：切子视图后范围保持，符合"同一组按钮语义"的直觉。
   */
  private async selectRange(spec: BoardSpec, range: TrafficRange) {
    if (range === this.trafficRange) return;
    this.trafficRange = range;
    this.el.querySelectorAll<HTMLButtonElement>(`#${spec.rangeId} button`).forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.range === range);
    });
    const token = this.token();
    if (!token) return;
    try {
      this.drawBoard(spec, await spec.fetchStats(token, range));
    } catch {
      /* 失败时保留当前图，不把看板清空 */
    }
  }

  /**
   * 条目列表：加载更多（两个子视图共用；`rowHtml` 是各自的行渲染函数）。
   *
   * 关键约定：翻页追加的行**必须与被首屏渲染的行来自同一个函数** —— 从前这里与首屏各抄了一份
   * `.log-row` 模板，导致"首屏改了、翻页没改"这类静默不一致（`truncateUa` 就是这么留下的）。
   */
  private bindMore<T extends { id: number }>(
    body: HTMLElement,
    spec: BoardSpec,
    token: string,
    firstPage: readonly T[],
    fetchPage: (before: number) => Promise<Page<T>>,
    rowHtml: (item: T) => string,
  ) {
    const more = body.querySelector<HTMLButtonElement>(`#${spec.moreId}`);
    if (!more) return;
    let last = firstPage.length ? firstPage[firstPage.length - 1].id : 0;
    more.addEventListener('click', async () => {
      try {
        const { items } = await fetchPage(last);
        const list = body.querySelector(`#${spec.listId}`);
        if (list && items.length) list.insertAdjacentHTML('beforeend', items.map(rowHtml).join(''));
        if (items.length) last = items[items.length - 1].id;
        // 不足一页即到底（保持既有行为：首页就不满一页时按钮一开始仍显示，点一次后收起）
        if (items.length === 0 || items.length < PAGE_SIZE) more.style.display = 'none';
      } catch {
        /* 忽略 */
      }
    });
  }

  // ---------- 条目行渲染（首屏与翻页共用） ----------

  private logRowsHtml(logs: readonly AccessLogEntry[]): string {
    return logs.map((l) => this.logRowHtml(l)).join('');
  }

  /**
   * 单行访问日志。
   *
   * 为什么要显示**完整 UA 且不截断**：需求就是"显示完整的浏览器环境"，而爬虫判定（版本过旧、
   * 无头浏览器）恰恰靠 UA 尾部的版本号/无头标记 —— 截断到 90 字正好把判定依据截掉。
   * 换行交给 CSS（`word-break: break-all`），不在这里做字符串截断。
   *
   * 未登录的访问按**判定结果**二选一：有爬虫判定理由 → 「爬虫」；没有任何理由 → 「游客」
   * （2026-09 用户二次确认的口径：标签与判定严格同源，不再"未登录即爬虫"）。
   */
  private logRowHtml(l: AccessLogEntry): string {
    const flagged = isBotEntry(l);
    // 「爬虫」作为用户名出现的条件：未登录 **且** 有判定依据（见 accessLog.showsBotLabel）
    const botUser = showsBotLabel(l);
    const botBadge = `<span class="log-bot">${t('admin.botLabel')}</span>`;
    // 判定依据（机器标签本地化）逐条展示，未知标签原样输出，不丢信息
    const reasons = botReasonLabels(l.botReasons)
      .map((r) => `<span class="log-bot-reason">${escapeHtml(r)}</span>`)
      .join('');
    // 「爬虫」已经占了用户名位置时，标签行里不再重复画一遍同款徽标（登录用户的徽标仍在这里出）
    const tags = [...(botUser ? [] : flagged ? [botBadge] : []), ...(reasons ? [reasons] : [])].join('');

    return `
      <div class="log-row${flagged ? ' log-row-bot' : ''}">
        <div class="log-main">
          <span class="log-time">${formatDateTime(l.createdAt)}</span>
          ${
            botUser
              ? botBadge
              : `<span class="log-user">${escapeHtml(logUserName(l))}</span>`
          }
          <span class="log-ip"><span class="log-ip-label">${t('admin.ipLabel')}</span>${escapeHtml(formatIpCell(l))}</span>
        </div>
        <div class="log-ua-line">
          <span class="log-ua-label">${t('admin.uaLabel')}</span>
          <span class="log-ua">${escapeHtml(formatUa(l.ua))}</span>
        </div>
        ${tags ? `<div class="log-tags">${tags}</div>` : ''}
        ${this.envDetailHtml(clientEnvRows(l.env))}
      </div>
    `;
  }

  /**
   * 可展开的环境详情：用 `<details>` 而不是自己写展开逻辑 ——
   * 原生元素自带键盘可达性与展开状态，面板重建 DOM 时也不必维护一份"哪些行展开了"的状态。
   * `env` 为 null（爬虫/旧客户端不上报环境）时显示占位，不留空白块。
   */
  private envDetailHtml(rows: { key: MessagesKey; value: string }[]): string {
    const grid = rows.length
      ? rows
          .map(
            (row) =>
              `<span class="log-env-key">${t(row.key)}</span><span class="log-env-val">${escapeHtml(row.value)}</span>`,
          )
          .join('')
      : `<span class="log-env-empty">${MISSING}</span>`;
    return `<details class="log-env"><summary class="log-env-summary">${t('admin.envDetail')}</summary><div class="log-env-grid">${grid}</div></details>`;
  }

  private playRowsHtml(plays: readonly PlayLogEntry[]): string {
    return plays.map((p) => this.playRowHtml(p)).join('');
  }

  /**
   * 单行游玩记录：时间 / 用户 / 模式名 / 来源。
   * 模式名走 `accessLog.playModeLabel`（内部复用 `modes/capabilities.ts` 的 `modeTitle`），
   * 不在管理端另造一份模式文案；未登录显示「未登录」（与日志的「爬虫」口径区分开）。
   */
  private playRowHtml(p: PlayLogEntry): string {
    const anonymous = isAnonymous(p.username);
    return `
      <div class="log-row">
        <div class="log-main">
          <span class="log-time">${formatDateTime(p.createdAt)}</span>
          <span class="log-user${anonymous ? ' log-user-anon' : ''}">${escapeHtml(playUserName(p.username))}</span>
          <span class="log-mode">${escapeHtml(playModeLabel(p.mode))}</span>
          <span class="log-source">${escapeHtml(playSourceLabel(p.source))}</span>
        </div>
      </div>
    `;
  }

  // ---------- 公告管理 ----------

  private async renderAnnouncements(body: HTMLElement) {
    const token = this.token();
    if (!token) throw new Error('no token');
    const list = await this.announcements.ensure();

    const editing = this.editingAnnouncementId !== null ? list.find((a) => a.id === this.editingAnnouncementId) : null;
    const formHtml = `
      <div class="admin-ann-form">
        <label class="form-row">${t('admin.annTitle')}<input id="ann-title" type="text" maxlength="${MAX_TITLE}" value="${escapeAttr(editing?.title ?? '')}" /></label>
        <label class="form-row">${t('admin.annContent')}<textarea id="ann-content" maxlength="${MAX_CONTENT}" rows="4">${escapeHtml(editing?.content ?? '')}</textarea></label>
        <label class="row"><input id="ann-pinned" type="checkbox" ${editing?.pinned ? 'checked' : ''} /> ${t('admin.annPin')}</label>
        <div class="card-actions">
          <button id="ann-save" class="primary" type="button">${editing ? t('admin.annUpdate') : t('admin.annPublish')}</button>
          ${editing ? `<button id="ann-cancel-edit" class="ghost" type="button">${t('common.cancel')}</button>` : ''}
        </div>
      </div>
    `;
    const listHtml = list.length
      ? list
          .map(
            (a) => `
            <div class="admin-ann-row">
              <div class="admin-ann-main">
                <span class="admin-ann-title">${escapeHtml(a.title)}</span>
                ${a.pinned ? `<span class="announcement-badge">${t('announcement.pinned')}</span>` : ''}
                <div class="admin-ann-content">${escapeHtml(a.content)}</div>
                <div class="admin-ann-time">${formatDateTime(a.createdAt)}</div>
              </div>
              <div class="admin-ann-actions">
                <button class="board-reply-btn" data-edit="${a.id}" type="button">${t('admin.annEdit')}</button>
                <button class="admin-ann-delete" data-delete="${a.id}" type="button">${t('admin.annDelete')}</button>
              </div>
            </div>`,
          )
          .join('')
      : `<div class="admin-empty">${t('admin.noAnnouncements')}</div>`;

    body.innerHTML = `${formHtml}<div class="admin-section-title">${t('admin.annListTitle')}</div><div class="admin-ann-list">${listHtml}</div>`;

    const save = body.querySelector<HTMLButtonElement>('#ann-save');
    if (save) save.addEventListener('click', () => void this.submitAnnouncement(body, editing));
    const cancelEdit = body.querySelector<HTMLButtonElement>('#ann-cancel-edit');
    if (cancelEdit) cancelEdit.addEventListener('click', () => { this.editingAnnouncementId = null; void this.renderBody(); });
    body.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.editingAnnouncementId = Number(btn.dataset.edit);
        void this.renderBody();
      });
    });
    body.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', () => void this.deleteAnnouncement(Number(btn.dataset.delete)));
    });
  }

  private async submitAnnouncement(body: HTMLElement, editing: { id: number; title: string; content: string; pinned: boolean } | null | undefined) {
    const token = this.token();
    if (!token) return;
    const title = (body.querySelector<HTMLInputElement>('#ann-title')?.value ?? '').trim();
    const content = (body.querySelector<HTMLTextAreaElement>('#ann-content')?.value ?? '').trim();
    const pinned = body.querySelector<HTMLInputElement>('#ann-pinned')?.checked ?? false;
    if (!title || !content) return;
    try {
      if (editing) await api.updateAnnouncement(token, editing.id, { title, content, pinned });
      else await api.createAnnouncement(token, { title, content, pinned });
      this.announcements.invalidate();
      this.editingAnnouncementId = null;
      await this.renderBody();
    } catch {
      /* 保留表单 */
    }
  }

  private async deleteAnnouncement(id: number) {
    const token = this.token();
    if (!token) return;
    if (!window.confirm(t('admin.annDeleteConfirm'))) return;
    try {
      await api.deleteAnnouncement(token, id);
      this.announcements.invalidate();
      if (this.editingAnnouncementId === id) this.editingAnnouncementId = null;
      await this.renderBody();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 子视图 → tab 文案。与 `render()` 里的 tabs 数组**必须同步**：漏一个会让视图无法进入
 * （不是编译错误，而是"点了没反应"），故两处放在一起、由 `AdminView` 联合类型兜底。
 */
function adminTabLabel(view: AdminView): string {
  if (view === 'users') return t('admin.tabUsers');
  if (view === 'logs') return t('admin.tabLogs');
  if (view === 'plays') return t('admin.tabPlays');
  return t('admin.tabAnnouncements');
}
