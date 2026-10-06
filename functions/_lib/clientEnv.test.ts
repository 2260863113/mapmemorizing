import { describe, it, expect } from 'vitest';
import {
  clientIp,
  MAX_ENV_JSON_LEN,
  normalizeIp,
  requestGeo,
  sanitizeClientEnv,
  sanitizeVisitorId,
  type ClientEnv,
} from './clientEnv';

/**
 * 客户端环境快照的白名单化。
 *
 * 为什么必须测：`/api/visit` 与 `/api/play` 的请求体是**任何人都能构造**的，而这个函数是
 * "什么能进 D1、什么最终会显示在管理端"的唯一闸门。两类错误都要防：
 *   · 拦不住 → 一条 100KB 的 `language` 直接进库、进管理端；
 *   · 抛出去 → 上报链路 500（脏 body 不该影响页面）。
 * 另外 `false` 是有意义的读数（"没开 Cookie"也是环境事实），不能被当成"空值"丢掉。
 */

/** 构造一个假请求：只用到 `headers` 与 `cf`，故直接断言成 Request。 */
function fakeRequest(headers: Record<string, string>, cf?: unknown): Request {
  return { headers: new Headers(headers), cf } as unknown as Request;
}

describe('sanitizeClientEnv · 非对象一律拒绝', () => {
  it('null/undefined/字符串/数字/布尔/数组都不是环境快照', () => {
    for (const bad of [null, undefined, '', 'Win32', 42, true, [], ['Win32'], () => 'Win32']) {
      expect(sanitizeClientEnv(bad), String(bad)).toBeNull();
    }
  });

  it('空对象或只有未知键 → null（"没报环境"与"报了空对象"对调用方是同义状态）', () => {
    expect(sanitizeClientEnv({})).toBeNull();
    expect(sanitizeClientEnv({ foo: 'bar', evil: '<script>', proto: 'x' })).toBeNull();
  });
});

describe('sanitizeClientEnv · 白名单与截断', () => {
  it('只保留契约里的字段，未知键丢弃（管理端不会渲染来路不明的键）', () => {
    expect(sanitizeClientEnv({ platform: 'Win32', foo: 'bar', ua: 'fake' })).toEqual({ platform: 'Win32' });
  });

  it('逐字段按上限截断而不是丢弃整条（客户端多报不该让环境整条消失）', () => {
    const out = sanitizeClientEnv({
      platform: 'p'.repeat(50),
      language: 'l'.repeat(50),
      languages: 'g'.repeat(200),
      timezone: 't'.repeat(80),
      screen: '1'.repeat(30),
      viewport: '2'.repeat(30),
      vendor: 'v'.repeat(80),
    });
    expect(out).toEqual({
      platform: 'p'.repeat(40),
      language: 'l'.repeat(40),
      languages: 'g'.repeat(120),
      timezone: 't'.repeat(60),
      screen: '1'.repeat(20),
      viewport: '2'.repeat(20),
      vendor: 'v'.repeat(60),
    });
  });

  it('首尾空白被去掉，纯空白字段视为未上报', () => {
    expect(sanitizeClientEnv({ platform: '  Win32  ', language: '   ' })).toEqual({ platform: 'Win32' });
  });

  it('非字符串的字符串字段一律丢弃（不替客户端做类型转换）', () => {
    expect(sanitizeClientEnv({ platform: 123, language: ['zh-CN'], timezone: { name: 'UTC' } })).toBeNull();
  });

  it('典型的完整环境原样通过，且体积远小于上限', () => {
    const full: ClientEnv = {
      platform: 'Win32',
      language: 'zh-CN',
      languages: 'zh-CN,zh,en',
      timezone: 'Asia/Shanghai',
      screen: '1920x1080',
      viewport: '1536x864',
      dpr: 1.25,
      cores: 16,
      memory: 8,
      touch: 0,
      webdriver: false,
      vendor: 'Google Inc.',
      cookie: true,
    };
    const out = sanitizeClientEnv(full);
    expect(out).toEqual(full);
    expect(JSON.stringify(out).length).toBeLessThan(MAX_ENV_JSON_LEN / 2);
  });
});

describe('sanitizeClientEnv · 数值与布尔', () => {
  it('dpr 保留小数，cores/memory/touch 向下取整', () => {
    expect(sanitizeClientEnv({ dpr: 2.625, cores: 8.9, memory: 7.5, touch: 5.99 })).toEqual({
      dpr: 2.625,
      cores: 8,
      memory: 7,
      touch: 5,
    });
  });

  it('0 是合法读数（无触控屏 maxTouchPoints=0），但负数/超上限/非有限数丢弃', () => {
    expect(sanitizeClientEnv({ touch: 0, cores: 0 })).toEqual({ touch: 0, cores: 0 });
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e9, '8', null, {}]) {
      expect(sanitizeClientEnv({ cores: bad, dpr: bad }), String(bad)).toBeNull();
    }
    expect(sanitizeClientEnv({ dpr: 0 })).toBeNull(); // dpr=0 不可能是真读数
    expect(sanitizeClientEnv({ dpr: 101 })).toBeNull();
  });

  it('布尔字段 `false` 必须保留：它是"没开 Cookie"这个环境事实，不是空值', () => {
    expect(sanitizeClientEnv({ webdriver: false, cookie: false })).toEqual({ webdriver: false, cookie: false });
    expect(sanitizeClientEnv({ webdriver: 'true', cookie: 1 })).toBeNull();
  });
});

describe('sanitizeClientEnv · 体积上限', () => {
  it('整体 JSON 超过上限 → 整条拒绝（不存"半条环境"让人误读）', () => {
    expect(sanitizeClientEnv({ language: 'a'.repeat(MAX_ENV_JSON_LEN) })).toBeNull();
    expect(sanitizeClientEnv({ platform: 'a'.repeat(MAX_ENV_JSON_LEN - 30), language: 'b'.repeat(60) })).toBeNull();
  });

  it('恰好在上限内仍被接受（边界不能误杀合法载荷）', () => {
    const raw = { platform: 'a'.repeat(MAX_ENV_JSON_LEN - 20) };
    expect(JSON.stringify(raw).length).toBeLessThanOrEqual(MAX_ENV_JSON_LEN);
    expect(sanitizeClientEnv(raw)).toEqual({ platform: 'a'.repeat(40) });
  });
});

describe('sanitizeClientEnv · 绝不抛错', () => {
  it('带抛错 getter 的字段被跳过，其余字段照常保留', () => {
    // 故意做成**不可枚举**：这样 JSON.stringify 会跳过它，能单独验证读字段那层的 try
    const hostile = Object.defineProperty({ language: 'zh-CN' }, 'platform', {
      get() {
        throw new Error('boom');
      },
      enumerable: false,
    });
    expect(() => sanitizeClientEnv(hostile)).not.toThrow();
    expect(sanitizeClientEnv(hostile)).toEqual({ language: 'zh-CN' });
  });

  it('循环引用 / BigInt 这类无法序列化的输入按"超限"丢弃，而不是抛出去', () => {
    const circle: Record<string, unknown> = {};
    circle.self = circle;
    expect(() => sanitizeClientEnv(circle)).not.toThrow();
    expect(sanitizeClientEnv(circle)).toBeNull();
    expect(sanitizeClientEnv({ cores: BigInt(8) })).toBeNull();
  });

  it('无原型的对象（Object.create(null)）照常处理', () => {
    const bare: Record<string, unknown> = Object.create(null);
    bare.platform = 'Win32';
    expect(sanitizeClientEnv(bare)).toEqual({ platform: 'Win32' });
  });
});

describe('normalizeIp', () => {
  it('识别 IPv4 / IPv6 并给出 v4 标记', () => {
    expect(normalizeIp('1.2.3.4')).toEqual({ ip: '1.2.3.4', v4: true });
    expect(normalizeIp('2001:db8::1')).toEqual({ ip: '2001:db8::1', v4: false });
  });

  it('空值/垃圾 → null', () => {
    for (const bad of ['', '   ', null, undefined, 'abc', '1.2.3', '256.1.1.1', 'a'.repeat(200)]) {
      expect(normalizeIp(bad), String(bad)).toBeNull();
    }
  });
});

describe('clientIp · 优先 IPv4（2026-10 需求 1）', () => {
  it('CF-Connecting-IP 是 IPv4 时直接用它（平台注入，客户端伪造不了）', () => {
    const request = fakeRequest({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1' });
    expect(clientIp(request)).toBe('203.0.113.7');
  });

  it('客户端是纯 IPv6 时改用 CF-Pseudo-IPv4（Cloudflare 合成的 IPv4）', () => {
    const request = fakeRequest({ 'cf-connecting-ip': '2001:db8::1', 'cf-pseudo-ipv4': '203.0.113.9' });
    expect(clientIp(request)).toBe('203.0.113.9');
  });

  it('拿不到任何 IPv4 时退回 IPv6（比丢地址强），并归一成小写', () => {
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '2001:DB8::ABCD' }))).toBe('2001:db8::abcd');
    // 伪造的伪 IPv4 头内容非法 → 不采信，仍回退到真实的 v6
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '2001:db8::1', 'cf-pseudo-ipv4': 'not-an-ip' }))).toBe('2001:db8::1');
  });

  it('IPv4-mapped IPv6（::ffff:1.2.3.4）折回点分四段 —— 它就是同一个 IPv4 地址', () => {
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '::ffff:203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '::FFFF:203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('带端口的写法剥掉端口（含 `[v6]:port` 的方括号形式）', () => {
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '203.0.113.7:5678' }))).toBe('203.0.113.7');
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '[2001:db8::1]:443' }))).toBe('2001:db8::1');
    // 裸 IPv6 的末段不是端口，不能被切掉
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('本地 dev 没有 CF 头时退化为 X-Forwarded-For 第一段（多级代理下最左才是真实客户端）', () => {
    expect(clientIp(fakeRequest({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1, 10.0.0.2' }))).toBe('198.51.100.9');
  });

  it('没有 CF 头时，也在本地候选里优先挑 IPv4（X-Real-IP 兜底）', () => {
    expect(clientIp(fakeRequest({ 'x-real-ip': '198.51.100.9' }))).toBe('198.51.100.9');
  });

  it('⚠ 有 CF 头时不采信客户端自带的 X-Forwarded-For（"优先 IPv4"不能降级为信任可伪造的头）', () => {
    const request = fakeRequest({ 'cf-connecting-ip': '2001:db8::1', 'x-forwarded-for': '203.0.113.7' });
    expect(clientIp(request)).toBe('2001:db8::1');
  });

  it('没有可用地址 → null（本地 wrangler pages dev 的正常情况）', () => {
    expect(clientIp(fakeRequest({}))).toBeNull();
    expect(clientIp(fakeRequest({ 'x-forwarded-for': '' }))).toBeNull();
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '   ' }))).toBeNull();
    expect(clientIp(fakeRequest({ 'x-forwarded-for': '  , 1.2.3.4' }))).toBeNull();
  });

  it('非法/超长/越界的值一律 null，而不是截断后入库（垃圾不该冒充地址）', () => {
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': 'a'.repeat(200) }))).toBeNull();
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '999.1.1.1' }))).toBeNull();
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '1.2.3' }))).toBeNull();
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '<script>alert(1)</script>' }))).toBeNull();
  });
});

describe('sanitizeVisitorId', () => {
  it('恰好 4 位数字才接受', () => {
    expect(sanitizeVisitorId('1234')).toBe('1234');
    expect(sanitizeVisitorId('0001')).toBe('0001');
    expect(sanitizeVisitorId('  5678  ')).toBe('5678');
  });

  it('其它形状一律 null（不在这里"兜底生成"：那会把同一个游客记成几十个人）', () => {
    for (const bad of ['', '123', '12345', 'abcd', '12a4', '12.4', 1234, null, undefined, {}, [], true]) {
      expect(sanitizeVisitorId(bad), String(bad)).toBeNull();
    }
  });
});

describe('requestGeo', () => {
  it('读 request.cf 的 country/region/city', () => {
    const request = fakeRequest({}, { country: 'US', region: 'California', city: 'San Jose' });
    expect(requestGeo(request)).toEqual({ country: 'US', region: 'California', city: 'San Jose' });
  });

  it('本地 dev 没有 request.cf → 全 null（不能一律当境外）', () => {
    expect(requestGeo(fakeRequest({}))).toEqual({ country: null, region: null, city: null });
    expect(requestGeo(fakeRequest({}, null))).toEqual({ country: null, region: null, city: null });
  });

  it('cf 里字段缺失或类型不对 → 该项 null，不影响其它项', () => {
    const request = fakeRequest({}, { country: 'JP', region: 42, city: null });
    expect(requestGeo(request)).toEqual({ country: 'JP', region: null, city: null });
    expect(requestGeo(fakeRequest({}, 'not-an-object'))).toEqual({ country: null, region: null, city: null });
  });

  it('地理字段去空白（cf 值为空白串时视为未知）', () => {
    expect(requestGeo(fakeRequest({}, { country: '  CN  ', city: '   ' }))).toEqual({ country: 'CN', region: null, city: null });
  });
});
