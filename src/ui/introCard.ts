import type { Announcement } from '../api';
import { AnnouncementStore } from '../announcementStore';
import { escapeHtml } from './html';
import { $ } from './dom';
import { t } from '../i18n';

const DISMISS_KEY = 'china-admin-intro-dismissed-v1';

/** 介绍卡片：首次进入弹出「站点介绍」公告；勾选不再显示后 localStorage 记录，仍可从公告栏查看。 */
export class IntroCard {
  private el: HTMLElement;

  constructor(containerId: string, private store: AnnouncementStore) {
    this.el = document.getElementById(containerId) as HTMLElement;
  }

  /** 启动时调用：若未标记「不再显示」且能取到介绍公告，则弹出。 */
  async maybeShow() {
    if (this.dismissed()) return;
    const intro = await this.store.intro();
    if (!intro) return;
    this.show(intro);
  }

  private dismissed(): boolean {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  }

  private show(intro: Announcement) {
    this.el.classList.remove('hidden');
    this.el.innerHTML = `
      <div class="card intro-card">
        <h3>${t('intro.title')}</h3>
        <div class="intro-subtitle">${escapeHtml(intro.title)}</div>
        <div class="intro-body">${escapeHtml(intro.content)}</div>
        <label class="intro-dismiss"><input id="intro-dismiss-check" type="checkbox" /> ${t('intro.noMore')}</label>
        <div class="card-actions">
          <button id="intro-start" class="primary" type="button">${t('intro.start')}</button>
        </div>
      </div>
    `;
    this.el.addEventListener('click', (event) => {
      if (event.target === this.el) this.close();
    });
    document.addEventListener('keydown', this.handleKey);
    ($('intro-start') as HTMLButtonElement).addEventListener('click', () => this.close());
    ($('intro-dismiss-check') as HTMLInputElement).addEventListener('change', (event) => {
      if ((event.target as HTMLInputElement).checked) this.persistDismiss();
    });
  }

  private close() {
    this.el.classList.add('hidden');
    document.removeEventListener('keydown', this.handleKey);
  }

  private persistDismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* 忽略存储失败 */
    }
  }

  private handleKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') this.close();
  };
}
