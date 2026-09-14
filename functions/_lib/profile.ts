/**
 * 「个人资料」接口的字段校验（纯逻辑，无 DB）。
 *
 * 为什么单独成模块：这三条校验是**安全相关**的 —— 头像的两个体积上限、家乡 adcode 的格式、
 * 以及改密码时的旧哈希比对。它们原先内联在 `api/auth/profile.ts` 的 handler 里，既无法单测，
 * 也被 79 行的长函数埋住。按 `_lib/board.ts` 的既有做法抽到这里，并配 `profile.test.ts`。
 *
 * 校验失败一律抛 `ApiError` —— `http.ts` 的 `handle()` 会把它转成
 * `json({ error: { code, message } }, status)`，与路由原先手写的响应体逐字相同。
 */
import { ApiError } from './http';
import { MAX_AVATAR_DATAURL_LEN, MAX_AVATAR_SIZE } from './limits';
import { normalizePasswordHash } from './validate';
import type { UserRow } from './auth';

export interface Hometown {
  provinceAdcode: string;
  cityAdcode: string;
}

export interface Avatar {
  dataUrl: string;
  name: string;
  size: number;
  type: string;
}

export interface ProfileBody {
  username?: unknown;
  hometown?: Hometown | null;
  avatar?: Avatar | null;
  oldPasswordHash?: unknown;
  newPasswordHash?: unknown;
}

/** 库里存的三件套（改密码时只用到这三列）。 */
export type PasswordTriple = Pick<UserRow, 'password_salt' | 'password_hash' | 'password_iterations'>;

const ADCODE_RE = /^\d{6}$/;

/**
 * 头像：前缀必须是 `data:image/`，size 有上限，且 dataUrl **实际长度**也有上限。
 * 最后一条是刻意的：只信客户端自报的 `size` 会让超大文本绕过限制入库。
 * `undefined` = 本次不改（沿用原值），`null` = 显式清空。
 */
export function resolveAvatar(body: ProfileBody, current: string | null): string | null {
  if (body.avatar === undefined) return current;
  if (body.avatar === null) return null;
  const av = body.avatar;
  if (typeof av.dataUrl !== 'string' || !av.dataUrl.startsWith('data:image/')) {
    throw new ApiError(400, 'invalid_avatar', '头像格式错误');
  }
  if (typeof av.size !== 'number' || av.size < 0 || av.size > MAX_AVATAR_SIZE) {
    throw new ApiError(400, 'invalid_avatar', '头像不能超过 20KB');
  }
  if (av.dataUrl.length > MAX_AVATAR_DATAURL_LEN) {
    throw new ApiError(400, 'invalid_avatar', '头像体积过大');
  }
  return JSON.stringify({ dataUrl: av.dataUrl, name: av.name ?? '', size: av.size, type: av.type ?? '' });
}

/** 家乡：省与市两个 adcode 都必须存在且为 6 位数字。`undefined` 沿用原值，`null` 清空。 */
export function resolveHometown(body: ProfileBody, current: string | null): string | null {
  if (body.hometown === undefined) return current;
  if (body.hometown === null) return null;
  const ht = body.hometown;
  if (typeof ht.provinceAdcode !== 'string' || typeof ht.cityAdcode !== 'string' || !ADCODE_RE.test(ht.provinceAdcode) || !ADCODE_RE.test(ht.cityAdcode)) {
    throw new ApiError(400, 'invalid_hometown', '家乡信息无效');
  }
  return JSON.stringify({ provinceAdcode: ht.provinceAdcode, cityAdcode: ht.cityAdcode });
}

/**
 * 改密码：旧哈希必须与库中一致，新哈希自带 salt / iterations。
 *
 * 两者都没提供 = 本次不改密码，沿用原值；**只提供一个**是客户端 bug，明确报 400
 * （而不是静默不改 —— 那会让用户以为改成功了）。
 */
export function resolvePassword(user: PasswordTriple, body: ProfileBody): { salt: string; hash: string; iterations: number } {
  const keep = { salt: user.password_salt, hash: user.password_hash, iterations: user.password_iterations };
  if (!body.oldPasswordHash && !body.newPasswordHash) return keep;
  if (!body.oldPasswordHash || !body.newPasswordHash) {
    throw new ApiError(400, 'old_password_required', '请输入旧密码和新密码');
  }
  let oldPwd: ReturnType<typeof normalizePasswordHash>;
  let newPwd: ReturnType<typeof normalizePasswordHash>;
  try {
    oldPwd = normalizePasswordHash(body.oldPasswordHash);
    newPwd = normalizePasswordHash(body.newPasswordHash);
  } catch {
    throw new ApiError(400, 'invalid_password_hash', '密码哈希格式错误');
  }
  if (oldPwd.hash !== user.password_hash || oldPwd.salt !== user.password_salt) {
    throw new ApiError(400, 'old_password_wrong', '旧密码不正确');
  }
  return { salt: newPwd.salt, hash: newPwd.hash, iterations: newPwd.iterations };
}
