import type { BoardPost, BoardReply } from './api';
import { api } from './api';

const PAGE_SIZE = 20;

/** 留言板：内存缓存 + API 调用。帖子列表按 id 倒序，分页拉取。 */
export class BoardStore {
  private posts: BoardPost[] = [];
  private hasMore = true;
  private loading = false;
  private expandedReplies = new Set<number>(); // 已展开全部回复的帖子 id
  private repliesCache = new Map<number, BoardReply[]>();

  getPosts(): BoardPost[] {
    return this.posts;
  }

  isExpanded(postId: number): boolean {
    return this.expandedReplies.has(postId);
  }

  /** 已展开帖子的完整回复列表（未展开返回 null）。 */
  getExpandedReplies(postId: number): BoardReply[] | null {
    return this.expandedReplies.has(postId) ? (this.repliesCache.get(postId) ?? null) : null;
  }

  /** 收起展开状态（回到前 3 条预览）。 */
  collapseReplies(postId: number): void {
    this.expandedReplies.delete(postId);
  }

  /** 清空并拉取第一页（模式切入时调用）。 */
  async refresh(): Promise<void> {
    this.posts = [];
    this.hasMore = true;
    this.expandedReplies.clear();
    this.repliesCache.clear();
    await this.loadMore();
  }

  /** 拉取下一页；已到末尾或正在加载时直接返回。 */
  async loadMore(): Promise<void> {
    if (this.loading || !this.hasMore) return;
    this.loading = true;
    try {
      const before = this.posts.length ? this.posts[this.posts.length - 1].id : 0;
      const res = await api.boardPosts(before, PAGE_SIZE);
      this.posts.push(...res.posts);
      this.hasMore = res.posts.length === PAGE_SIZE;
    } finally {
      this.loading = false;
    }
  }

  /** 展开某帖全部回复（分页合并）。 */
  async expandReplies(postId: number): Promise<void> {
    if (this.expandedReplies.has(postId)) return;
    const all: BoardReply[] = [];
    let before = 0;
    for (;;) {
      const res = await api.boardReplies(postId, before, PAGE_SIZE);
      all.push(...res.replies);
      if (res.replies.length < PAGE_SIZE) break;
      before = all.length ? all[all.length - 1].id : 0;
    }
    this.repliesCache.set(postId, all);
    this.expandedReplies.add(postId);
  }

  /** 创建帖子并插入列表顶部。 */
  async createPost(token: string, content: string): Promise<BoardPost> {
    const res = await api.createPost(token, content);
    this.posts.unshift(res.post);
    return res.post;
  }

  /** 创建回复：追加到该帖的展开缓存 + 计数 +1。 */
  async createReply(token: string, postId: number, content: string): Promise<BoardReply> {
    const res = await api.createReply(token, postId, content);
    const cached = this.repliesCache.get(postId);
    if (cached) cached.push(res.reply);
    const post = this.posts.find((p) => p.id === postId);
    if (post) {
      post.replyCount += 1;
      if (post.replies.length < 3) post.replies.push(res.reply);
    }
    return res.reply;
  }

  /** 删除帖子并移除列表项。 */
  async deletePost(token: string, postId: number): Promise<void> {
    await api.deletePost(token, postId);
    this.posts = this.posts.filter((p) => p.id !== postId);
    this.expandedReplies.delete(postId);
    this.repliesCache.delete(postId);
  }

  /** 删除回复：从展开缓存与预览中移除，计数 -1。 */
  async deleteReply(token: string, postId: number, replyId: number): Promise<void> {
    await api.deleteReply(token, replyId);
    const cached = this.repliesCache.get(postId);
    if (cached) {
      const idx = cached.findIndex((r) => r.id === replyId);
      if (idx >= 0) cached.splice(idx, 1);
    }
    const post = this.posts.find((p) => p.id === postId);
    if (post) {
      post.replies = post.replies.filter((r) => r.id !== replyId);
      post.replyCount = Math.max(0, post.replyCount - 1);
    }
  }
}
