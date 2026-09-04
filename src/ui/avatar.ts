/** 共享头像渲染：有头像显示图片，无头像显示用户名首字母彩色块。 */

import { escapeAttr, escapeHtml } from './html';

const AVATAR_COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#be123c', '#b45309', '#15803d', '#0369a1', '#9f1239'];

export function avatarColor(username: string): string {
  let hash = 0;
  for (const ch of username) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function initialOf(username: string): string {
  const ch = username.trim().charAt(0);
  return ch ? ch.toLocaleUpperCase() : '?';
}

export interface AvatarSource {
  username: string;
  avatar: string | null;
}

/** 返回小头像 HTML：有头像→圆形图片，无头像→首字母彩色块。 */
export function avatarHtml(user: AvatarSource, sizeClass = ''): string {
  const cls = sizeClass ? ` user-avatar mini ${sizeClass}` : ' user-avatar mini';
  if (user.avatar) {
    return `<span class="${cls}" style="background-image:url('${escapeAttr(user.avatar)}')"></span>`;
  }
  const color = avatarColor(user.username);
  return `<span class="${cls}" style="background-color:${color}">${escapeHtml(initialOf(user.username))}</span>`;
}
