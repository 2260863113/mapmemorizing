import { BoardStore } from '../boardStore';
import type { AuthStore } from '../authStore';
import type { AuthPanel } from './authPanel';
import { avatarHtml } from './avatar';
import { escapeHtml } from './html';
import { formatRelative } from './dateFormat';
import type { BoardPost, BoardReply } from '../api';
import { t } from '../i18n';

const MAX_POST = 200;
const MAX_REPLY = 100;

/** 留言板：模式标签点击后主区切换为发帖/回复视图。 */
export class BoardPanel {
  private el: HTMLElement;
  private expandedReplyInput: number | null = null;

  constructor(
    containerId: string,
    private store: BoardStore,
    private auth: AuthStore,
    private authPanel: AuthPanel,
  ) {
    this.el = document.getElementById(containerId) as HTMLElement;
  }

  /** 模式切入：拉取第一页并渲染。 */
  async show() {
    this.el.classList.remove('hidden');
    this.el.innerHTML = '';
    await this.refresh();
  }

  hide() {
    this.el.classList.add('hidden');
  }

  private async refresh() {
    try {
      await this.store.refresh();
    } catch {
      this.renderError();
      return;
    }
    this.render();
  }

  // ---------- 渲染 ----------

  private render() {
    const user = this.auth.currentUser();
    const posts = this.store.getPosts();
    const listHtml = posts.length
      ? `<div class="board-list">${posts.map((p) => this.renderPost(p)).join('')}</div>
         <button id="board-load-more" class="board-load-more" type="button">${t('board.loadMore')}</button>`
      : `<div class="board-empty">${t('board.empty')}</div>`;

    this.el.innerHTML = `
      <div class="board-container">
        <h2 class="board-heading">${t('board.title')}</h2>
        <div class="board-composer">
          <textarea id="board-new-content" maxlength="${MAX_POST}" rows="2" placeholder="${t('board.postPlaceholder')}"></textarea>
          <div class="board-composer-actions">
            <span id="board-new-count" class="board-count">0/${MAX_POST}</span>
            <button id="board-new-submit" class="primary" type="button">${t('board.post')}</button>
          </div>
        </div>
        <div class="board-login-hint${user ? ' hidden' : ''}">${t('board.loginHint')}</div>
        ${listHtml}
      </div>
    `;
    this.bindEvents(user);
    const textarea = document.getElementById('board-new-content') as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.addEventListener('input', () => {
        const count = document.getElementById('board-new-count');
        if (count) count.textContent = `${Array.from(textarea.value).length}/${MAX_POST}`;
      });
    }
  }

  private renderPost(post: BoardPost): string {
    const user = this.auth.currentUser();
    const mine = user !== null && user.username === post.username;
    const expanded = this.store.isExpanded(post.id);
    const expandedReplies = this.store.getExpandedReplies(post.id);
    const visibleReplies = expandedReplies ?? post.replies.slice(0, 3);
    const repliesHtml = visibleReplies.map((r) => this.renderReply(post.id, r)).join('');
    const hiddenCount = post.replyCount - visibleReplies.length;
    const expandBtn = expanded
      ? `<button class="board-expand" data-action="collapse" data-post="${post.id}" type="button">${t('board.collapse')}</button>`
      : hiddenCount > 0
        ? `<button class="board-expand" data-action="expand" data-post="${post.id}" type="button">${t('board.expand', { count: hiddenCount })}</button>`
        : '';
    const replyInput = this.expandedReplyInput === post.id ? this.renderReplyInput(post.id) : '';
    const postAvatar = avatarHtml({ username: post.username, avatar: post.avatar });

    return `
      <div class="board-post" data-post="${post.id}">
        <div class="board-post-head">
          ${postAvatar}
          <span class="board-author">${escapeHtml(post.username)}</span>
          <span class="board-time">${formatRelative(post.createdAt)}</span>
          ${mine ? `<button class="board-delete" data-action="delete-post" data-post="${post.id}" type="button">${t('board.delete')}</button>` : ''}
        </div>
        <div class="board-content">${escapeHtml(post.content)}</div>
        ${repliesHtml ? `<div class="board-replies">${repliesHtml}</div>` : ''}
        <div class="board-post-actions">
          ${expandBtn}
          <button class="board-reply-btn" data-action="toggle-reply" data-post="${post.id}" type="button">${t('board.reply')}</button>
        </div>
        ${replyInput}
      </div>
    `;
  }

  private renderReply(postId: number, reply: BoardReply): string {
    const user = this.auth.currentUser();
    const mine = user !== null && user.username === reply.username;
    const replyAvatar = avatarHtml({ username: reply.username, avatar: reply.avatar });
    return `
      <div class="board-reply" data-reply="${reply.id}">
        <div class="board-reply-head">
          ${replyAvatar}
          <span class="board-author">${escapeHtml(reply.username)}</span>
          <span class="board-time">${formatRelative(reply.createdAt)}</span>
          ${mine ? `<button class="board-delete" data-action="delete-reply" data-post="${postId}" data-reply="${reply.id}" type="button">${t('board.delete')}</button>` : ''}
        </div>
        <div class="board-content">${escapeHtml(reply.content)}</div>
      </div>
    `;
  }

  private renderReplyInput(postId: number): string {
    return `
      <div class="board-reply-input">
        <textarea data-role="reply-content" maxlength="${MAX_REPLY}" rows="1" placeholder="${t('board.replyPlaceholder')}"></textarea>
        <button class="primary" data-action="submit-reply" data-post="${postId}" type="button">${t('board.reply')}</button>
      </div>
    `;
  }

  private renderError() {
    this.el.innerHTML = `<div class="board-empty">${t('board.loadFailed')}</div>`;
  }

  // ---------- 事件 ----------

  private bindEvents(user: ReturnType<AuthStore['currentUser']>) {
    this.el.querySelector('#board-new-submit')?.addEventListener('click', () => this.submitPost());
    this.el.querySelector('#board-load-more')?.addEventListener('click', () => this.loadMore());
    this.el.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const action = btn.dataset.action;
        const postId = Number(btn.dataset.post);
        const replyId = Number(btn.dataset.reply);
        if (action === 'toggle-reply') {
          this.expandedReplyInput = this.expandedReplyInput === postId ? null : postId;
          this.render();
        } else if (action === 'expand') {
          void this.expand(postId);
        } else if (action === 'collapse') {
          this.store.collapseReplies(postId);
          this.render();
        } else if (action === 'delete-post') {
          void this.deletePost(postId);
        } else if (action === 'delete-reply') {
          void this.deleteReply(postId, replyId);
        } else if (action === 'submit-reply') {
          void this.submitReply(postId);
        }
      });
    });
  }

  // ---------- 操作 ----------

  private async loadMore() {
    try {
      await this.store.loadMore();
    } catch {
      this.toastError();
      return;
    }
    this.render();
  }

  private async expand(postId: number) {
    try {
      await this.store.expandReplies(postId);
    } catch {
      this.toastError();
      return;
    }
    this.render();
  }

  private submitPost() {
    if (!this.requireLogin()) return;
    const textarea = this.el.querySelector<HTMLTextAreaElement>('#board-new-content');
    if (!textarea) return;
    const content = textarea.value.trim();
    if (!content) return;
    const token = this.auth.sessionToken();
    if (!token) return;
    void (async () => {
      try {
        await this.store.createPost(token, content);
        this.render();
      } catch {
        this.toastError();
      }
    })();
  }

  private submitReply(postId: number) {
    if (!this.requireLogin()) return;
    const textarea = this.el.querySelector<HTMLTextAreaElement>(`[data-action="submit-reply"][data-post="${postId}"]`)
      ?.parentElement?.querySelector<HTMLTextAreaElement>('[data-role="reply-content"]');
    if (!textarea) return;
    const content = textarea.value.trim();
    if (!content) return;
    const token = this.auth.sessionToken();
    if (!token) return;
    void (async () => {
      try {
        await this.store.createReply(token, postId, content);
        this.expandedReplyInput = null;
        this.render();
      } catch {
        this.toastError();
      }
    })();
  }

  private async deletePost(postId: number) {
    if (!this.requireLogin()) return;
    const token = this.auth.sessionToken();
    if (!token) return;
    if (!window.confirm(t('board.confirmDeletePost'))) return;
    try {
      await this.store.deletePost(token, postId);
      this.render();
    } catch {
      this.toastError();
    }
  }

  private async deleteReply(postId: number, replyId: number) {
    if (!this.requireLogin()) return;
    const token = this.auth.sessionToken();
    if (!token) return;
    if (!window.confirm(t('board.confirmDeleteReply'))) return;
    try {
      await this.store.deleteReply(token, postId, replyId);
      this.render();
    } catch {
      this.toastError();
    }
  }

  /** 未登录时跳到登录界面（登录成功后刷新面板，回到已登录态）。 */
  private requireLogin(): boolean {
    if (this.auth.currentUser()) return true;
    this.authPanel.requestLogin(() => this.render());
    return false;
  }

  private toastError() {
    // 复用全局 toast（存在 #toast 元素）
    const toast = document.getElementById('toast');
    if (toast) {
      toast.textContent = t('board.submitFailed');
      toast.classList.add('show');
      window.setTimeout(() => toast.classList.remove('show'), 2400);
    }
  }
}
