import { BoardStore } from '../boardStore';
import type { AuthStore } from '../authStore';
import type { AuthPanel } from './authPanel';
import { avatarHtml } from './avatar';
import { escapeHtml } from './html';
import { formatRelative } from './dateFormat';
import { toast } from './dom';
import { clearDraft, loadDraft, saveDraft } from './boardDraft';
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
    const draft = loadDraft(); // 草稿回填：登录跳转/切模式/刷新后内容仍在（见 boardDraft.ts）
    const listHtml = posts.length
      ? `<div class="board-list">${posts.map((p) => this.renderPost(p)).join('')}</div>
         <button id="board-load-more" class="board-load-more" type="button">${t('board.loadMore')}</button>`
      : `<div class="board-empty">${t('board.empty')}</div>`;

    this.el.innerHTML = `
      <div class="board-container">
        <h2 class="board-heading">${t('board.title')}</h2>
        <div class="board-composer">
          <textarea id="board-new-content" maxlength="${MAX_POST}" rows="2" placeholder="${t('board.postPlaceholder')}">${escapeHtml(draft)}</textarea>
          <div class="board-composer-actions">
            <span id="board-new-count" class="board-count">${Array.from(draft).length}/${MAX_POST}</span>
            <button id="board-new-submit" class="primary" type="button">${t('board.post')}</button>
          </div>
        </div>
        <div class="board-login-hint${user ? ' hidden' : ''}">${t('board.loginHint')}</div>
        ${listHtml}
      </div>
    `;
    this.bindEvents();
    const textarea = document.getElementById('board-new-content') as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.addEventListener('input', () => {
        saveDraft(textarea.value); // 随打随存：登录跳转/误刷新都不会丢
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

  private bindEvents() {
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

  /**
   * 发布留言。
   *
   * 未登录时**先把内容取出来**再走登录门控，并让登录/注册成功后的回调直接用它发布
   * （用户口径 2026-09：登录或注册之后直接发布，不再让用户重写）。内容同时随打随存在
   * localStorage，故中途放弃登录、切模式、刷新都不会丢（见 boardDraft.ts）。
   */
  private submitPost() {
    const content = this.composerValue();
    if (!content) return;
    if (!this.auth.currentUser()) {
      this.authPanel.requestLogin(() => this.publishPost(content));
      return;
    }
    this.publishPost(content);
  }

  /** 输入框内容（输入框不在场时回落到草稿 —— 例如登录回调在重绘之后才跑起来）。 */
  private composerValue(): string {
    const textarea = this.el.querySelector<HTMLTextAreaElement>('#board-new-content');
    return (textarea ? textarea.value : loadDraft()).trim();
  }

  /** 真正发布（登录后自动续发也走这里）：**成功才清草稿**；失败则把内容放回输入框并提示。 */
  private publishPost(content: string) {
    const token = this.auth.sessionToken();
    if (!token) return;
    void (async () => {
      // try 只包住网络调用：发布成功之后的重绘 / 提示若出错，不该被当成「发布失败」而把草稿又存回去
      // （否则用户会以为没发出去，再点一次就重复发帖）。
      try {
        await this.store.createPost(token, content);
      } catch {
        saveDraft(content);
        this.render(); // render 会把草稿回填进输入框，用户的内容还在
        this.toastError();
        return;
      }
      clearDraft();
      this.render();
      toast(t('board.posted'));
    })();
  }

  private submitReply(postId: number) {
    const content = this.replyValue(postId);
    if (!content) return;
    if (!this.auth.currentUser()) {
      this.authPanel.requestLogin(() => this.publishReply(postId, content));
      return;
    }
    this.publishReply(postId, content);
  }

  private replyValue(postId: number): string {
    const textarea = this.replyBoxOf(postId);
    return textarea ? textarea.value.trim() : '';
  }

  private replyBoxOf(postId: number): HTMLTextAreaElement | null {
    return (
      this.el
        .querySelector<HTMLButtonElement>(`[data-action="submit-reply"][data-post="${postId}"]`)
        ?.parentElement?.querySelector<HTMLTextAreaElement>('[data-role="reply-content"]') ?? null
    );
  }

  /** 真正发布回复（登录后自动续发也走这里）：成功后收起回复框；失败保留回复框与内容。 */
  private publishReply(postId: number, content: string) {
    const token = this.auth.sessionToken();
    if (!token) return;
    void (async () => {
      try {
        await this.store.createReply(token, postId, content);
      } catch {
        this.expandedReplyInput = postId; // 保持回复框展开
        this.render();
        const textarea = this.replyBoxOf(postId);
        if (textarea) textarea.value = content;
        this.toastError();
        return;
      }
      this.expandedReplyInput = null;
      this.render();
      toast(t('board.replied'));
    })();
  }

  private async deletePost(postId: number) {
    if (!this.requireLogin(() => this.render())) return;
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
    if (!this.requireLogin(() => this.render())) return;
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

  /**
   * 未登录时跳到登录界面，登录/注册成功后执行 `then`。
   *
   * 发布/回复传「继续发布」的回调（用户口径：登录或注册之后直接发布）；删除这类**破坏性**操作
   * 只传 `() => this.render()` —— 登录后自动删帖风险太大，让用户再点一次。
   */
  private requireLogin(then: () => void): boolean {
    if (this.auth.currentUser()) return true;
    this.authPanel.requestLogin(then);
    return false;
  }

  private toastError() {
    toast(t('board.submitFailed'));
  }
}
