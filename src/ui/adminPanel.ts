import type { AuthStore } from '../authStore';
import type { AnnouncementStore } from '../announcementStore';
import type { AdminUser, AccessLogEntry, AccessStats } from '../api';
import { api } from '../api';
import { avatarHtml } from './avatar';
import { escapeAttr, escapeHtml } from './html';
import { formatDate, formatDateTime } from './dateFormat';
import { normalizeProvince } from '../matcher';
import type { AppData } from '../types';
import { t } from '../i18n';

export type AdminView = 'users' | 'logs' | 'announcements';

const MAX_TITLE = 60;
const MAX_CONTENT = 2000;

/** 管理员面板：用户管理 / 日志记录 / 公告管理 三个子视图，主区切换。 */
export class AdminPanel {
  private el: HTMLElement;
  private view: AdminView = 'users';
  private editingAnnouncementId: number | null = null;

  constructor(
    containerId: string,
    private auth: AuthStore,
    private announcements: AnnouncementStore,
    private data: AppData,
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

  private render() {
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

  private async renderLogs(body: HTMLElement) {
    const token = this.token();
    if (!token) throw new Error('no token');
    const [stats, logs] = await Promise.all([api.adminStats(token), api.adminLogs(token)]);

    const dayHtml = stats.days.length
      ? stats.days.map((d) => `<div class="stat-row"><span>${escapeHtml(d.day)}</span><span class="stat-count">${d.count}</span></div>`).join('')
      : `<div class="admin-empty">${t('admin.noStats')}</div>`;
    const hourHtml = stats.hours.length
      ? stats.hours
          .slice()
          .reverse()
          .map((h) => `<div class="stat-row"><span>${escapeHtml(h.hour)}</span><span class="stat-count">${h.count}</span></div>`)
          .join('')
      : `<div class="admin-empty">${t('admin.noStats')}</div>`;
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
      <div class="admin-stats-grid">
        <div class="stat-panel"><div class="stat-panel-title">${t('admin.daysTitle')}</div>${dayHtml}</div>
        <div class="stat-panel"><div class="stat-panel-title">${t('admin.hoursTitle')}</div>${hourHtml}</div>
      </div>
      <div class="admin-section-title">${t('admin.logsTitle')}</div>
      <div class="admin-log-list">${logHtml}</div>
      <button id="admin-log-more" class="board-load-more" type="button">${t('admin.loadMore')}</button>
    `;
    const more = body.querySelector<HTMLButtonElement>('#admin-log-more');
    if (more) {
      more.addEventListener('click', async () => {
        const last = logs.logs.length ? logs.logs[logs.logs.length - 1].id : 0;
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
          if (next.logs.length === 0 || next.logs.length < 50) more.style.display = 'none';
        } catch {
          /* 忽略 */
        }
      });
    }
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
