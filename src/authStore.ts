import type { AuthUser, PasswordHash, UserAvatar, UserHometown } from './types';
import { t } from './i18n';

const AUTH_KEY = 'china-admin-auth-v1';
const AUTH_VERSION = 1;
const HASH_ITERATIONS = 120_000;

interface AuthState {
  version: number;
  currentUsername: string | null;
  users: Record<string, AuthUser>;
}

export interface ProfileUpdate {
  username: string;
  hometown: UserHometown | null;
  avatar: UserAvatar | null;
  oldPassword?: string;
  newPassword?: string;
}

export class AuthStore {
  private state: AuthState = { version: AUTH_VERSION, currentUsername: null, users: {} };
  private listeners = new Set<() => void>();

  constructor() {
    this.state = this.load();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  currentUser(): AuthUser | null {
    const key = this.state.currentUsername;
    return key ? this.state.users[key] ?? null : null;
  }

  allUsers(): AuthUser[] {
    return Object.values(this.state.users).sort((a, b) => a.createdAt - b.createdAt);
  }

  hasUsers(): boolean {
    return Object.keys(this.state.users).length > 0;
  }

  async register(username: string, password: string): Promise<AuthUser> {
    const cleaned = cleanUsername(username);
    if (!cleaned) throw new Error(t('auth.error.usernameRequired'));
    if (!validPassword(password)) throw new Error(t('auth.error.passwordTooShort'));
    const key = usernameKey(cleaned);
    if (this.state.users[key]) throw new Error(t('auth.error.usernameExists'));

    const now = Date.now();
    const user: AuthUser = {
      username: cleaned,
      password: await hashPassword(password),
      hometown: null,
      avatar: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.users[key] = user;
    this.state.currentUsername = key;
    this.persist();
    return user;
  }

  async login(username: string, password: string): Promise<AuthUser> {
    const key = usernameKey(username);
    const user = this.state.users[key];
    if (!user) throw new Error(t('auth.error.userNotFound'));
    const ok = await verifyPassword(password, user.password);
    if (!ok) throw new Error(t('auth.error.wrongPassword'));
    this.state.currentUsername = key;
    this.persist();
    return user;
  }

  logout() {
    this.state.currentUsername = null;
    this.persist();
  }

  async updateProfile(update: ProfileUpdate): Promise<AuthUser> {
    const currentKey = this.state.currentUsername;
    const current = currentKey ? this.state.users[currentKey] : null;
    if (!current || !currentKey) throw new Error(t('auth.error.loginRequired'));

    const username = cleanUsername(update.username);
    if (!username) throw new Error(t('auth.error.usernameRequired'));
    const nextKey = usernameKey(username);
    if (nextKey !== currentKey && this.state.users[nextKey]) throw new Error(t('auth.error.usernameExists'));

    let password = current.password;
    const wantsPassword = update.oldPassword || update.newPassword;
    if (wantsPassword) {
      if (!update.oldPassword) throw new Error(t('auth.error.oldPasswordRequired'));
      if (!validPassword(update.newPassword ?? '')) throw new Error(t('auth.error.newPasswordTooShort'));
      const ok = await verifyPassword(update.oldPassword, current.password);
      if (!ok) throw new Error(t('auth.error.oldPasswordWrong'));
      password = await hashPassword(update.newPassword ?? '');
    }

    const next: AuthUser = {
      ...current,
      username,
      password,
      hometown: update.hometown,
      avatar: update.avatar,
      updatedAt: Date.now(),
    };

    if (nextKey !== currentKey) delete this.state.users[currentKey];
    this.state.users[nextKey] = next;
    this.state.currentUsername = nextKey;
    this.persist();
    return next;
  }

  private load(): AuthState {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (!raw) return { version: AUTH_VERSION, currentUsername: null, users: {} };
      const parsed = JSON.parse(raw) as Partial<AuthState>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: AUTH_VERSION, currentUsername: null, users: {} };
      const users: Record<string, AuthUser> = {};
      const inputUsers = parsed.users && typeof parsed.users === 'object' && !Array.isArray(parsed.users) ? parsed.users : {};
      for (const value of Object.values(inputUsers)) {
        const user = normalizeUser(value);
        if (!user) continue;
        users[usernameKey(user.username)] = user;
      }
      const current = typeof parsed.currentUsername === 'string' ? usernameKey(parsed.currentUsername) : null;
      return {
        version: AUTH_VERSION,
        currentUsername: current && users[current] ? current : null,
        users,
      };
    } catch {
      return { version: AUTH_VERSION, currentUsername: null, users: {} };
    }
  }

  private persist() {
    try {
      localStorage.setItem(AUTH_KEY, JSON.stringify(this.state));
    } catch {
      /* 忽略存储失败 */
    }
    for (const fn of this.listeners) fn();
  }
}

function normalizeUser(value: unknown): AuthUser | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<AuthUser>;
  const username = cleanUsername(row.username);
  const password = normalizePassword(row.password);
  if (!username || !password) return null;
  return {
    username,
    password,
    hometown: normalizeHometown(row.hometown),
    avatar: normalizeAvatar(row.avatar),
    createdAt: finiteTime(row.createdAt),
    updatedAt: finiteTime(row.updatedAt),
  };
}

function normalizePassword(value: unknown): PasswordHash | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<PasswordHash>;
  if (row.algorithm !== 'PBKDF2-SHA-256') return null;
  if (typeof row.salt !== 'string' || typeof row.hash !== 'string') return null;
  const iterations = typeof row.iterations === 'number' && Number.isFinite(row.iterations) ? Math.floor(row.iterations) : HASH_ITERATIONS;
  if (iterations < 1) return null;
  return { algorithm: row.algorithm, salt: row.salt, hash: row.hash, iterations };
}

function normalizeHometown(value: unknown): UserHometown | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<UserHometown>;
  if (typeof row.provinceAdcode !== 'string' || typeof row.cityAdcode !== 'string') return null;
  if (!/^\d{6}$/.test(row.provinceAdcode) || !/^\d{6}$/.test(row.cityAdcode)) return null;
  return { provinceAdcode: row.provinceAdcode, cityAdcode: row.cityAdcode };
}

function normalizeAvatar(value: unknown): UserAvatar | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<UserAvatar>;
  if (typeof row.dataUrl !== 'string' || !row.dataUrl.startsWith('data:image/')) return null;
  if (typeof row.name !== 'string' || typeof row.type !== 'string') return null;
  const size = typeof row.size === 'number' && Number.isFinite(row.size) ? Math.floor(row.size) : 0;
  if (size < 0 || size > 20 * 1024) return null;
  return { dataUrl: row.dataUrl, name: row.name, size, type: row.type };
}

function cleanUsername(username: unknown): string {
  return typeof username === 'string' ? username.trim().replace(/\s+/g, ' ').slice(0, 24) : '';
}

function usernameKey(username: string): string {
  return cleanUsername(username).toLowerCase();
}

function validPassword(password: string) {
  return password.length >= 6;
}

function finiteTime(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', textBytes(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: HASH_ITERATIONS }, key, 256);
  return {
    algorithm: 'PBKDF2-SHA-256',
    salt: bytesToBase64(salt),
    hash: bytesToBase64(new Uint8Array(bits)),
    iterations: HASH_ITERATIONS,
  };
}

async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const salt = base64ToBytes(stored.salt);
  const key = await crypto.subtle.importKey('raw', textBytes(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: stored.iterations }, key, 256);
  return bytesToBase64(new Uint8Array(bits)) === stored.hash;
}

function textBytes(value: string) {
  return new TextEncoder().encode(value);
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
