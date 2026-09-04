/** 全站共享的业务常量（单一事实源，供各 API 与校验复用）。 */

/** 留言板帖子/回复长度上限（与前端 boardPanel 的 MAX_POST/MAX_REPLY 一致）。 */
export const MAX_POST_LEN = 200;
export const MAX_REPLY_LEN = 100;

/** 公告标题/正文长度上限（与前端 adminPanel 的 MAX_TITLE/MAX_CONTENT 一致）。 */
export const MAX_ANNOUNCEMENT_TITLE = 60;
export const MAX_ANNOUNCEMENT_CONTENT = 2000;

/** 头像 dataUrl 长度上限（约 20KB 原始图片的 base64 膨胀上限，前端 compressImage 目标 20KB）。 */
export const MAX_AVATAR_SIZE = 20 * 1024;
export const MAX_AVATAR_DATAURL_LEN = 40 * 1024;

/** 用户名长度上限（与前端 authStore.cleanUsername 的 slice(0,24) 一致）。 */
export const MAX_USERNAME_LEN = 24;
