import type { AuthStore } from '../authStore';
import type { AnnouncementStore } from '../announcementStore';
import type { AdminUser, AccessStats } from '../api';
import { api } from '../api';
import { avatarHtml } from './avatar';
import { escapeAttr, escapeHtml } from './html';
import { formatDate, formatDateTime } from './dateFormat';
import { normalizeProvince } from '../matcher';
import type { AppData, Settings } from '../types';
import { t } from '../i18n';
import { TrafficChart } from './trafficChart';
import type { AdminPanelDiagnostics } from './adminPanelDiagnostics';
import {
  DEFAULT_TRAFFIC_RANGE,
  isEmptyTraffic,
  normalizeTrafficPoints,
  normalizeTrafficRange,
  normalizeTrafficUnit,
  trafficRangeSpec,
  trafficUnitKey,
  TRAFFIC_RANGES,
  type TrafficPoint,
  type TrafficRange,
  type TrafficUnit,
} from './trafficSeries';

export type AdminView = 'users' | 'logs' | 'announcements';

const MAX_TITLE = 60;
const MAX_CONTENT = 2000;

/** 管理员面板：用户管理 / 日志记录 / 公告管理 三个子视图，主区切换。 */
export class AdminPanel {
  private el: HTMLElement;
  private view: AdminView = 'users';
  private editingAnnouncementId: number | null = null;
  /** 流量看板当前范围（会话内记忆；切换子视图后保留，避免每次都跳回默认）。 */
  private trafficRange: TrafficRange = DEFAULT_TRAFFIC_RANGE;
  /** 流量折线图实例：**必须在重建 `#admin-body` 之前销毁**（见 `./trafficChart.ts` 的说明）。 */
  private traffic: TrafficChart | null = null;
  /** 最近一次画出的点序列与粒度：主题切换时用原数据重上色，不重新请求。 */
  private trafficPoints: TrafficPoint[] | null = null;
  private trafficUnit: TrafficUnit = 'day';

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
   */
  applyTheme() {
    if (!this.traffic || !this.trafficPoints) return;
    this.traffic.render(this.trafficPoints, this.trafficUnit, this.settings.darkMode);
  }

  /**
   * 销毁流量图实例。**重建 `#admin-body` 之前必须调用**：容器元素会被 innerHTML 换掉，
   * 不销毁就等于把 ECharts 实例与它的 canvas 一起丢掉（切几次 tab 泄漏几个）。
   */
  private disposeTraffic() {
    this.traffic?.dispose();
    this.traffic = null;
    this.trafficPoints = null;
  }

  /**
   * 验收探针的**只读**诊断视图（见 `./adminPanelDiagnostics.ts` 的说明）。
   * 生产路径不调用（只有 URL 带 `?probe=1` 时探针取一次）。
   */
  diagnostics(): AdminPanelDiagnostics {
    const self = this;
    return {
      get view() { return self.view; },
      get trafficRange() { return self.trafficRange; },
      get trafficMounted() { return self.traffic?.mounted === true; },
      get trafficUnit() { return self.trafficUnit; },
      get trafficPointCount() { return self.trafficPoints?.length ?? 0; },
      get trafficCounts() { return (self.trafficPoints ?? []).map((p) => p.count); },
      get trafficLabels() { return (self.trafficPoints ?? []).map((p) => p.label); },
      trafficCanvasCount: () => self.traffic?.canvasCount() ?? 0,
      trafficHeight: () => self.traffic?.height() ?? 0,
      trafficReadback: () => self.traffic?.readback() ?? null,
      /** 第 index 个数据点在**页面坐标**下的像素位置（脚本据此派发真实鼠标事件）。 */
      trafficPointClientPixel: (index) => {
        const point = self.trafficPoints?.[index];
        if (!point || !self.traffic) return null;
        const pixel = self.traffic.pointPixel(index, point.count);
        if (!pixel) return null;
        const rect = self.trafficElement()?.getBoundingClientRect();
        if (!rect) return null;
        return [rect.left + pixel[0], rect.top + pixel[1]];
      },
      /** 图表容器在页面坐标下的矩形（脚本用来判断鼠标落点是否在图上）。 */
      trafficRect: () => {
        const rect = self.trafficElement()?.getBoundingClientRect();
        return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
      },
      /** 空态文案元素当前是否可见。 */
      get trafficEmptyVisible() {
        const el = self.el.querySelector<HTMLElement>('#admin-traffic-empty');
        return !!el && !el.classList.contains('hidden');
      },
    };
  }

  private trafficElement(): HTMLElement | null {
    return this.el.querySelector<HTMLElement>('#admin-traffic');
  }

  private render() {
    this.disposeTraffic(); // 下面这行会换掉整个面板的 DOM（含图表容器）
    const tabs = (['users', 'logs', 'announcements'] as AdminView[])
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

  // ---------- 日志记录 ----------

  /**
   * 日志记录视图：**流量看板（折线图 + 范围选择）** + 访问明细列表。
   *
   * 布局口径（用户本轮的改动要求）：折线图仍然放在这个子视图里、不新开 tab；
   * 三个范围按钮与项目既有分段按钮同一套样式（`.mode-segmented`），点击只**局部刷新图表**
   * （见 `selectTrafficRange`：不重建 `#admin-body`，因此不会丢滚动位置、也不会闪一下）。
   */
  private async renderLogs(body: HTMLElement) {
    const token = this.token();
    if (!token) throw new Error('no token');
    const [stats, logs] = await Promise.all([api.adminStats(token, this.trafficRange), api.adminLogs(token)]);

    const logHtml = logs.logs.length
      ? logs.logs
          .map(
            (l) =>
              `<div class="log-row"><span class="log-time">${formatDateTime(l.createdAt)}</span><span class="log-user">${l.username ? escapeHtml(l.username) : t('admin.guest')}</span><span class="log-ua">${escapeHtml(truncateUa(l.ua))}</span></div>`,
          )
          .join('')
      : `<div class="admin-empty">${t('admin.noLogs')}</div>`;

    body.innerHTML = `
      <div class="admin-section-title">${t('admin.statsTitle')}</div>
      <div class="admin-traffic">
        <div class="admin-traffic-head">
          <div class="mode-segmented" id="admin-traffic-range">${this.rangeButtonsHtml()}</div>
          <span class="admin-traffic-unit" id="admin-traffic-unit"></span>
        </div>
        <div class="admin-traffic-chart" id="admin-traffic"></div>
        <div class="admin-traffic-empty admin-empty hidden" id="admin-traffic-empty">${t('admin.noStats')}</div>
      </div>
      <div class="admin-section-title">${t('admin.logsTitle')}</div>
      <div class="admin-log-list">${logHtml}</div>
      <button id="admin-log-more" class="board-load-more" type="button">${t('admin.loadMore')}</button>
    `;

    const chartEl = this.trafficElement();
    if (chartEl) {
      this.traffic = new TrafficChart(chartEl);
      this.drawTraffic(stats);
    }
    // 范围按钮：只切 active 与图表，不重建面板 DOM
    body.querySelectorAll<HTMLButtonElement>('#admin-traffic-range button').forEach((btn) => {
      btn.addEventListener('click', () => void this.selectTrafficRange(normalizeTrafficRange(btn.dataset.range)));
    });
    this.bindLogMore(body, token, logs.logs.length ? logs.logs[logs.logs.length - 1].id : 0);
  }

  /** 三个范围按钮（当前范围带 `active`）。 */
  private rangeButtonsHtml(): string {
    return TRAFFIC_RANGES.map((range) => {
      const cls = range === this.trafficRange ? ' class="active"' : '';
      return `<button type="button"${cls} data-range="${range}">${t(trafficRangeSpec(range).labelKey)}</button>`;
    }).join('');
  }

  /** 画一次图 + 同步粒度提示与空态（数据来自服务端，`unit` 以服务端为准）。 */
  private drawTraffic(stats: AccessStats) {
    const points = normalizeTrafficPoints(stats.points);
    this.trafficPoints = points;
    this.trafficUnit = normalizeTrafficUnit(stats.unit);
    this.traffic?.render(points, this.trafficUnit, this.settings.darkMode);

    const unitEl = this.el.querySelector<HTMLElement>('#admin-traffic-unit');
    if (unitEl) unitEl.textContent = t(trafficUnitKey(this.trafficUnit));
    this.el.querySelector<HTMLElement>('#admin-traffic-empty')?.classList.toggle('hidden', !isEmptyTraffic(points));
  }

  /**
   * 切范围：**只**刷新图表（不重建 `#admin-body`）。
   *
   * 为什么不做整页重渲染：那会把访问明细列表与滚动位置一起清掉，用户每切一次范围就被弹回
   * 顶部（而且图表会先消失再出现）。这里只改按钮的 active 类与图表内容。
   */
  private async selectTrafficRange(range: TrafficRange) {
    if (range === this.trafficRange) return;
    this.trafficRange = range;
    this.el.querySelectorAll<HTMLButtonElement>('#admin-traffic-range button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.range === range);
    });
    const token = this.token();
    if (!token) return;
    try {
      this.drawTraffic(await api.adminStats(token, range));
    } catch {
      /* 失败时保留当前图，不把看板清空 */
    }
  }

  /** 访问明细：加载更多（保持原行为）。 */
  private bindLogMore(body: HTMLElement, token: string, lastId: number) {
    const more = body.querySelector<HTMLButtonElement>('#admin-log-more');
    if (!more) return;
    let last = lastId;
    more.addEventListener('click', async () => {
      try {
        const next = await api.adminLogs(token, last);
        const list = body.querySelector('.admin-log-list');
        if (list && next.logs.length) {
          list.insertAdjacentHTML(
            'beforeend',
            next.logs
              .map(
                (l) =>
                  `<div class="log-row"><span class="log-time">${formatDateTime(l.createdAt)}</span><span class="log-user">${l.username ? escapeHtml(l.username) : t('admin.guest')}</span><span class="log-ua">${escapeHtml(truncateUa(l.ua))}</span></div>`,
              )
              .join(''),
          );
        }
        if (next.logs.length) last = next.logs[next.logs.length - 1].id;
        if (next.logs.length === 0 || next.logs.length < 50) more.style.display = 'none';
      } catch {
        /* 忽略 */
      }
    });
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

function adminTabLabel(view: AdminView): string {
  if (view === 'users') return t('admin.tabUsers');
  if (view === 'logs') return t('admin.tabLogs');
  return t('admin.tabAnnouncements');
}

function truncateUa(ua: string): string {
  return ua.length > 90 ? ua.slice(0, 90) + '…' : ua;
}
