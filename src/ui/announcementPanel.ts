import type { Announcement } from '../api';
import { AnnouncementStore } from '../announcementStore';
import { escapeHtml } from './html';
import { formatDate } from './dateFormat';
import { t } from '../i18n';

/** 公告浮层：居中展示全部历史公告（标题+正文完整显示，不折叠）。 */
export class AnnouncementPanel {
  private el: HTMLElement;

  constructor(containerId: string, private store: AnnouncementStore) {
    this.el = document.getElementById(containerId) as HTMLElement;
  }

  async open() {
    this.el.classList.remove('hidden');
    this.el.innerHTML = `<div class="card announcement-card"><h3>${t('announcement.title')}</h3><div id="announcement-list" class="announcement-list"></div><div class="card-actions"><button id="announcement-close" class="ghost" type="button">${t('common.close')}</button></div></div>`;
    const close = document.getElementById('announcement-close');
    if (close) close.addEventListener('click', () => this.close());
    this.el.addEventListener('click', (event) => {
      if (event.target === this.el) this.close();
    });
    document.addEventListener('keydown', this.handleKey);

    const listEl = document.getElementById('announcement-list');
    if (!listEl) return;
    listEl.innerHTML = `<div class="announcement-loading">${t('announcement.loading')}</div>`;
    try {
      const list = await this.store.ensure();
      if (list.length === 0) {
        listEl.innerHTML = `<div class="announcement-empty">${t('announcement.empty')}</div>`;
        return;
      }
      listEl.innerHTML = list
        .map(
          (a) =>
            `<div class="announcement-item${a.pinned ? ' pinned' : ''}"><div class="announcement-head"><span class="announcement-title">${escapeHtml(a.title)}</span>${a.pinned ? `<span class="announcement-badge">${t('announcement.pinned')}</span>` : ''}<span class="announcement-time">${formatDate(a.createdAt)}</span></div><div class="announcement-body">${escapeHtml(a.content)}</div></div>`,
        )
        .join('');
    } catch {
      listEl.innerHTML = `<div class="announcement-empty">${t('announcement.loadFailed')}</div>`;
    }
  }

  close() {
    this.el.classList.add('hidden');
    document.removeEventListener('keydown', this.handleKey);
  }

  private handleKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') this.close();
  };
}
