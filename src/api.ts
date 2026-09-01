import type { LeaderboardEntry } from './leaderboardStore';
import type { RoundResult, UserProfile } from './types';

/** 留言板帖子（含前 3 条预览回复）。 */
export interface BoardPost {
  id: number;
  content: string;
  createdAt: number;
  username: string;
  avatar: string | null;
  replyCount: number;
  replies: BoardReply[];
}

/** 留言板回复。 */
export interface BoardReply {
  id: number;
  postId: number;
  content: string;
  createdAt: number;
  username: string;
  avatar: string | null;
}

/** 统一 fetch 封装：部署后与 Pages Functions 同源（相对路径 /api）；本地 dev 由 vite 代理转发。 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const BASE = '/api';

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let code = 'unknown';
    let message = '请求失败';
    try {
      const data = await res.json();
      code = data?.error?.code ?? code;
      message = data?.error?.message ?? message;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError(res.status, code, message);
  }
  return res.json() as Promise<T>;
}

export interface PasswordHashPayload {
  algorithm: 'PBKDF2-SHA-256';
  salt: string;
  hash: string;
  iterations: number;
}

export interface AuthResponse {
  token: string;
  user: UserProfile;
}

export const api = {
  register: (body: { username: string; passwordHash: PasswordHashPayload }) =>
    request<AuthResponse>('/auth/register', { method: 'POST', body }),
  salt: (username: string) => request<{ salt: string; iterations: number }>('/auth/salt', { method: 'POST', body: { username } }),
  login: (body: { username: string; passwordHash: PasswordHashPayload }) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body }),
  logout: (token: string) => request<{ ok: true }>('/auth/logout', { method: 'POST', token }),
  me: (token: string) => request<{ user: UserProfile }>('/auth/me', { token }),
  updateProfile: (
    token: string,
    body: {
      username: string;
      hometown: UserProfile['hometown'];
      avatar: UserProfile['avatar'];
      oldPasswordHash?: PasswordHashPayload | null;
      newPasswordHash?: PasswordHashPayload | null;
    },
  ) => request<{ user: UserProfile }>('/auth/profile', { method: 'POST', token, body }),
  submitScore: (token: string, result: RoundResult) =>
    request<{ status: 'added' | 'improved' | 'kept' }>('/score', { method: 'POST', token, body: result }),
  leaderboard: (mode: string, scope: string | null) =>
    request<{ entries: LeaderboardEntry[] }>(`/leaderboard?mode=${encodeURIComponent(mode)}&scope=${scope ? encodeURIComponent(scope) : ''}`),
  // ---------- 留言板 ----------
  boardPosts: (before = 0, limit = 20) =>
    request<{ posts: BoardPost[] }>(`/board?before=${before}&limit=${limit}`),
  boardReplies: (postId: number, before = 0, limit = 20) =>
    request<{ replies: BoardReply[] }>(`/board?post=${postId}&before=${before}&limit=${limit}`),
  createPost: (token: string, content: string) =>
    request<{ post: BoardPost }>('/board', { method: 'POST', token, body: { content } }),
  createReply: (token: string, postId: number, content: string) =>
    request<{ reply: BoardReply }>('/board/reply', { method: 'POST', token, body: { postId, content } }),
  deletePost: (token: string, id: number) =>
    request<{ ok: true }>(`/board/${id}`, { method: 'DELETE', token }),
  deleteReply: (token: string, id: number) =>
    request<{ ok: true }>(`/board/reply/${id}`, { method: 'DELETE', token }),
};
