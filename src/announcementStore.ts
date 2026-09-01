import type { Announcement } from './api';
import { api } from './api';

/** 公告：内存缓存 + API 拉取。 */
export class AnnouncementStore {
  private cache: Promise<Announcement[]> | null = null;

  /** 拉取公告（置顶优先 + 时间倒序）；失败不入缓存以便下次重试。 */
  ensure(): Promise<Announcement[]> {
    if (this.cache) return this.cache;
    const promise = api
      .announcements()
      .then((r) => r.announcements)
      .catch((err) => {
        this.cache = null;
        throw err;
      });
    this.cache = promise;
    return promise;
  }

  /** 公告变更（发布/修改/删除）后清缓存。 */
  invalidate() {
    this.cache = null;
  }

  /** 置顶的站点介绍公告（标题为「站点介绍」或 pinned），用于介绍卡片。 */
  async intro(): Promise<Announcement | null> {
    try {
      const list = await this.ensure();
      return list.find((a) => a.pinned) ?? list[0] ?? null;
    } catch {
      return null;
    }
  }
}
