import { describe, it, expect } from 'vitest';
import { ApiError } from './http';
import { MAX_AVATAR_DATAURL_LEN, MAX_AVATAR_SIZE } from './limits';
import { resolveAvatar, resolveHometown, resolvePassword, type PasswordTriple } from './profile';

/**
 * 个人资料接口的三条字段校验。
 *
 * 为什么值得单测：它们是**安全相关**的（头像两个体积上限、家乡 adcode 格式、改密码时的旧哈希
 * 比对），但此前内联在 `api/auth/profile.ts` 的 handler 里，既没有测试也测不了 —— 路由文件
 * 只能靠起一个 D1 才能跑。抽到 `_lib/profile.ts` 后，这些规则可以像纯函数一样断言。
 *
 * 响应体的**形状**由 `http.ts` 的 `handle()` 统一负责（`ApiError` → `json({error:{code,message}}, status)`），
 * 所以这里只断言 code，不重复断言 HTTP 层。
 */

/** 抓取被抛出的 ApiError（断言 code 比断言文案稳）。 */
function apiErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  throw new Error('预期抛出 ApiError，但函数正常返回了');
}

const okAvatar = { dataUrl: 'data:image/png;base64,AAAA', name: 'a.png', size: 1024, type: 'image/png' };

describe('resolveAvatar', () => {
  it('未提供时沿用原值（undefined ≠ 清空）', () => {
    expect(resolveAvatar({}, '原头像')).toBe('原头像');
  });

  it('显式 null 表示清空', () => {
    expect(resolveAvatar({ avatar: null }, '原头像')).toBeNull();
  });

  it('合法头像序列化后入库（name/type 缺失时补空串）', () => {
    const out = resolveAvatar({ avatar: okAvatar }, null);
    expect(JSON.parse(out as string)).toEqual(okAvatar);
    const loose = resolveAvatar({ avatar: { dataUrl: okAvatar.dataUrl, size: 1 } as never }, null);
    expect(JSON.parse(loose as string)).toEqual({ dataUrl: okAvatar.dataUrl, name: '', size: 1, type: '' });
  });

  it('拒绝非 data:image/ 前缀（含 http 外链与 javascript:）', () => {
    for (const dataUrl of ['http://x/a.png', 'javascript:alert(1)', 'data:text/html,<b>', '']) {
      expect(apiErrorCode(() => resolveAvatar({ avatar: { ...okAvatar, dataUrl } }, null)), dataUrl).toBe('invalid_avatar');
    }
  });

  it('拒绝超限或非法的 size', () => {
    expect(apiErrorCode(() => resolveAvatar({ avatar: { ...okAvatar, size: MAX_AVATAR_SIZE + 1 } }, null))).toBe('invalid_avatar');
    expect(apiErrorCode(() => resolveAvatar({ avatar: { ...okAvatar, size: -1 } }, null))).toBe('invalid_avatar');
    expect(apiErrorCode(() => resolveAvatar({ avatar: { ...okAvatar, size: '1024' as never } }, null))).toBe('invalid_avatar');
  });

  it('dataUrl 实际长度超限也拒绝 —— 不能只信客户端自报的 size', () => {
    // size 谎报为 1，但 dataUrl 超长：必须按实际长度拦下
    const huge = { ...okAvatar, size: 1, dataUrl: 'data:image/png;base64,' + 'A'.repeat(MAX_AVATAR_DATAURL_LEN) };
    expect(apiErrorCode(() => resolveAvatar({ avatar: huge }, null))).toBe('invalid_avatar');
  });
});

describe('resolveHometown', () => {
  it('未提供时沿用原值，显式 null 清空', () => {
    expect(resolveHometown({}, '原家乡')).toBe('原家乡');
    expect(resolveHometown({ hometown: null }, '原家乡')).toBeNull();
  });

  it('合法 6 位 adcode 序列化后入库', () => {
    const out = resolveHometown({ hometown: { provinceAdcode: '440000', cityAdcode: '440100' } }, null);
    expect(JSON.parse(out as string)).toEqual({ provinceAdcode: '440000', cityAdcode: '440100' });
  });

  it('拒绝非 6 位或非数字的 adcode', () => {
    const bad = [
      { provinceAdcode: '44', cityAdcode: '440100' },
      { provinceAdcode: '440000', cityAdcode: '4401000' },
      { provinceAdcode: '44xxxx', cityAdcode: '440100' },
      { provinceAdcode: 440000 as never, cityAdcode: '440100' },
    ];
    for (const hometown of bad) {
      expect(apiErrorCode(() => resolveHometown({ hometown }, null))).toBe('invalid_hometown');
    }
  });
});

const PBKDF2 = 'PBKDF2-SHA-256';
const SALT = 'c2FsdA==';
const HASH = 'aGFzaA==';
const ITER = 200000;

/** 库里已存的密码三件套。 */
const STORED: PasswordTriple = { password_salt: SALT, password_hash: HASH, password_iterations: ITER };

function payload(salt = SALT, hash = HASH, iterations = ITER) {
  return { algorithm: PBKDF2, salt, hash, iterations };
}

describe('resolvePassword', () => {
  it('新旧哈希都没提供 = 本次不改密码，沿用原值', () => {
    expect(resolvePassword(STORED, {})).toEqual({ salt: SALT, hash: HASH, iterations: ITER });
  });

  it('只提供一个哈希是客户端 bug：明确报错，而不是静默不改', () => {
    expect(apiErrorCode(() => resolvePassword(STORED, { oldPasswordHash: payload() }))).toBe('old_password_required');
    expect(apiErrorCode(() => resolvePassword(STORED, { newPasswordHash: payload() }))).toBe('old_password_required');
  });

  it('旧哈希与库中一致时换成新的 salt/hash/iterations', () => {
    const next = payload('bmV3c2FsdA==', 'bmV3aGFzaA==', 300000);
    expect(resolvePassword(STORED, { oldPasswordHash: payload(), newPasswordHash: next })).toEqual({
      salt: 'bmV3c2FsdA==',
      hash: 'bmV3aGFzaA==',
      iterations: 300000,
    });
  });

  it('旧哈希或旧 salt 对不上 → old_password_wrong', () => {
    expect(apiErrorCode(() => resolvePassword(STORED, { oldPasswordHash: payload(SALT, 'd3Jvbmc='), newPasswordHash: payload() }))).toBe(
      'old_password_wrong',
    );
    expect(apiErrorCode(() => resolvePassword(STORED, { oldPasswordHash: payload('d3Jvbmc=', HASH), newPasswordHash: payload() }))).toBe(
      'old_password_wrong',
    );
  });

  it('哈希结构不合法（算法 / 迭代次数）→ invalid_password_hash', () => {
    const wrongAlgo = { ...payload(), algorithm: 'MD5' };
    expect(apiErrorCode(() => resolvePassword(STORED, { oldPasswordHash: wrongAlgo, newPasswordHash: payload() }))).toBe('invalid_password_hash');
    expect(apiErrorCode(() => resolvePassword(STORED, { oldPasswordHash: payload(SALT, HASH, 1000), newPasswordHash: payload() }))).toBe(
      'invalid_password_hash',
    );
    expect(apiErrorCode(() => resolvePassword(STORED, { oldPasswordHash: 'not-an-object', newPasswordHash: payload() }))).toBe(
      'invalid_password_hash',
    );
  });
});
