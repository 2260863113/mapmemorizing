import type { UserAvatar, UserHometown, UserProfile } from './types';
import { t } from './i18n';
import { api, ApiError, type PasswordHashPayload } from './api';

const SESSION_KEY = 'china-admin-session-v1';
const HASH_ITERATIONS = 120_000;

export interface ProfileUpdate {
  username: string;
  hometown: UserHometown | null;
  avatar: UserAvatar | null;
  oldPassword?: string;
  newPassword?: string;
}

interface SessionState {
  token: string;
  user: UserProfile;
}

export class AuthStore {
  private session: SessionState | null = null;
  private listeners = new Set<() => void>();

  constructor() {
    this.session = this.load();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 同步读缓存（启动时不阻塞、不白屏）。 */
  currentUser(): UserProfile | null {
    return this.session?.user ?? null;
  }

  sessionToken(): string | null {
    return this.session?.token ?? null;
  }

  async register(username: string, password: string): Promise<UserProfile> {
    const cleaned = cleanUsername(username);
    if (!cleaned) throw new Error(t('auth.error.usernameRequired'));
    if (!validPassword(password)) throw new Error(t('auth.error.passwordTooShort'));
    const pwd = await hashPassword(password);
    const res = await api.register({ username: cleaned, passwordHash: pwd });
    this.session = { token: res.token, user: res.user };
    this.persist();
    return res.user;
  }

  async login(username: string, password: string): Promise<UserProfile> {
    const cleaned = cleanUsername(username);
    if (!cleaned) throw new Error(t('auth.error.usernameRequired'));
    let saltInfo: { salt: string; iterations: number };
    try {
      saltInfo = await api.salt(cleaned);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw new Error(t('auth.error.userNotFound'));
      throw new Error(t('auth.error.network'));
    }
    const pwd = await hashWithSalt(password, saltInfo.salt, saltInfo.iterations);
    let res;
    try {
      res = await api.login({ username: cleaned, passwordHash: pwd });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw new Error(t('auth.error.wrongPassword'));
      throw new Error(t('auth.error.network'));
    }
    this.session = { token: res.token, user: res.user };
    this.persist();
    return res.user;
  }

  logout() {
    const token = this.session?.token;
    if (token) void api.logout(token).catch(() => {});
    this.session = null;
    this.persist();
  }

  /** 会话失效（401）时清空本地登录态。 */
  clearSession() {
    this.session = null;
    this.persist();
  }

  /** 启动时后台校验已存会话；401 清除，网络错误静默保留缓存。 */
  async restoreSession() {
    if (!this.session) return;
    const token = this.session.token;
    try {
      const res = await api.me(token);
      this.session = { token, user: res.user };
      this.persist();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.clearSession();
      // 网络错误：保留缓存，待下一次请求再校验
    }
  }

  async updateProfile(update: ProfileUpdate): Promise<UserProfile> {
    const session = this.session;
    if (!session) throw new Error(t('auth.error.loginRequired'));

    const username = cleanUsername(update.username);
    if (!username) throw new Error(t('auth.error.usernameRequired'));

    const wantsPassword = update.oldPassword || update.newPassword;
    let oldPasswordHash: PasswordHashPayload | null = null;
    let newPasswordHash: PasswordHashPayload | null = null;
    if (wantsPassword) {
      if (!update.oldPassword) throw new Error(t('auth.error.oldPasswordRequired'));
      if (!validPassword(update.newPassword ?? '')) throw new Error(t('auth.error.newPasswordTooShort'));
      [oldPasswordHash, newPasswordHash] = await hashPair(update.oldPassword, update.newPassword ?? '', username);
    }

    let res;
    try {
      res = await api.updateProfile(session.token, {
        username,
        hometown: update.hometown,
        avatar: update.avatar,
        oldPasswordHash,
        newPasswordHash,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'old_password_wrong') throw new Error(t('auth.error.oldPasswordWrong'));
        if (err.code === 'username_exists') throw new Error(t('auth.error.usernameExists'));
      }
      throw new Error(t('auth.error.network'));
    }

    this.session = { token: session.token, user: res.user };
    this.persist();
    return res.user;
  }

  /** 独立修改密码：保留用户名/所在地/头像不变，仅替换密码哈希。 */
  async changePassword(oldPassword: string, newPassword: string): Promise<UserProfile> {
    const session = this.session;
    if (!session) throw new Error(t('auth.error.loginRequired'));
    const username = session.user.username;
    if (!validPassword(newPassword)) throw new Error(t('auth.error.newPasswordTooShort'));

    const [oldPasswordHash, newPasswordHash] = await hashPair(oldPassword, newPassword, username);

    let res;
    try {
      res = await api.updateProfile(session.token, {
        username,
        hometown: session.user.hometown,
        avatar: session.user.avatar,
        oldPasswordHash,
        newPasswordHash,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'old_password_wrong') throw new Error(t('auth.error.oldPasswordWrong'));
      }
      throw new Error(t('auth.error.network'));
    }

    this.session = { token: session.token, user: res.user };
    this.persist();
    return res.user;
  }

  private load(): SessionState | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<SessionState>;
      if (typeof parsed.token !== 'string' || !parsed.token) return null;
      if (!parsed.user || typeof parsed.user.username !== 'string') return null;
      return { token: parsed.token, user: parsed.user as UserProfile };
    } catch {
      return null;
    }
  }

  private persist() {
    try {
      if (this.session) localStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      /* 忽略存储失败 */
    }
    for (const fn of this.listeners) fn();
  }
}

function cleanUsername(username: unknown): string {
  return typeof username === 'string' ? username.trim().replace(/\s+/g, ' ').slice(0, 24) : '';
}

function validPassword(password: string) {
  return password.length >= 6;
}

/** 注册/改密：新随机 salt 的完整哈希。 */
async function hashPassword(password: string): Promise<PasswordHashPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, HASH_ITERATIONS);
  return { algorithm: 'PBKDF2-SHA-256', salt: bytesToBase64(salt), hash: bytesToBase64(new Uint8Array(hash)), iterations: HASH_ITERATIONS };
}

/** 登录/验证：用服务端给的 salt 重算哈希。 */
async function hashWithSalt(password: string, saltB64: string, iterations: number): Promise<PasswordHashPayload> {
  const salt = base64ToBytes(saltB64);
  const hash = await derive(password, salt, iterations);
  return { algorithm: 'PBKDF2-SHA-256', salt: saltB64, hash: bytesToBase64(new Uint8Array(hash)), iterations };
}

/** 改密/改资料：取服务端 salt 一次，同时算旧哈希（验旧密码）与新哈希（新随机 salt）。 */
async function hashPair(oldPassword: string, newPassword: string, username: string): Promise<[PasswordHashPayload, PasswordHashPayload]> {
  let saltInfo: { salt: string; iterations: number };
  try {
    saltInfo = await api.salt(username);
  } catch {
    throw new Error(t('auth.error.network'));
  }
  const oldPasswordHash = await hashWithSalt(oldPassword, saltInfo.salt, saltInfo.iterations);
  const newPasswordHash = await hashPassword(newPassword);
  return [oldPasswordHash, newPasswordHash];
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', textBytes(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

function textBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(value);
  return bytes as Uint8Array<ArrayBuffer>;
}

function bytesToBase64(bytes: Uint8Array) {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

function base64ToBytes(value: string) {
  const text = atob(value);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}


