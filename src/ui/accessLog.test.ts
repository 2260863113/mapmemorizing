import { describe, it, expect } from 'vitest';
import {
  botReasonLabel,
  botReasonLabels,
  clientEnvRows,
  formatIpCell,
  formatUa,
  isAnonymous,
  isBotEntry,
  logUserName,
  playScopeLabel,
  showsBotLabel,
  MISSING,
  playModeLabel,
  playSourceLabel,
  playUserName,
} from './accessLog';
import { modeTitle } from '../modes/capabilities';

/**
 * 管理端列表的纯格式化。
 *
 * 为什么必须测：这些映射全是「错了也看不出来」的一类 —— 少映射一条 `botReasons` 只是界面上
 * 少一个判定标签（页面照样正常），IP / 城市拼错顺序看起来也像正常数据。而它们不碰 DOM，
 * 可以逐字断言；`adminPanel.ts`（import 了 echarts）则测不动。
 */

describe('爬虫判定标签 → 文案', () => {
  it('四个固定标签各自有中文文案', () => {
    expect(botReasonLabel('overseas')).toBe('境外 IP');
    expect(botReasonLabel('headless')).toBe('无头浏览器');
    expect(botReasonLabel('old_browser')).toBe('版本过旧');
    expect(botReasonLabel('automation')).toBe('自动化标记');
  });

  it('keyword: 标签带上命中词（前后空格清理掉）', () => {
    expect(botReasonLabel('keyword:curl')).toBe('关键词 curl');
    expect(botReasonLabel('keyword: python-requests')).toBe('关键词 python-requests');
  });

  it('未知标签原样显示（前端表旧了也不能丢判定信息）', () => {
    expect(botReasonLabel('brand_new_reason')).toBe('brand_new_reason');
    // 关键词为空的脏标签退化成原样，不渲染成「关键词 」
    expect(botReasonLabel('keyword:')).toBe('keyword:');
    expect(botReasonLabel('keyword:   ')).toBe('keyword:');
  });

  it('空标签被丢弃；顺序与去重保持服务端给的顺序', () => {
    expect(botReasonLabel('')).toBe('');
    expect(botReasonLabel(null)).toBe('');
    expect(botReasonLabel(undefined)).toBe('');
    expect(botReasonLabels(['headless', '', 'overseas'])).toEqual(['无头浏览器', '境外 IP']);
    expect(botReasonLabels(null)).toEqual([]);
  });

  it('bot 为 false 但带理由时仍视为爬虫（结论与依据不一致时不丢信息）', () => {
    expect(isBotEntry({ bot: true, botReasons: [] })).toBe(true);
    expect(isBotEntry({ bot: false, botReasons: ['overseas'] })).toBe(true);
    expect(isBotEntry({ bot: false, botReasons: [''] })).toBe(false);
    expect(isBotEntry(null)).toBe(false);
  });
});

describe('用户 / IP / UA', () => {
  it('未登录：有判定理由才是「爬虫」，没有理由是「游客」（2026-09 二次确认口径）', () => {
    expect(logUserName({ username: 'admintest', bot: false, botReasons: [] })).toBe('admintest');
    expect(logUserName({ username: null, bot: true, botReasons: ['headless'] })).toBe('爬虫');
    // bot 结论与理由不一致时按「有依据」处理（见 isBotEntry 的说明）
    expect(logUserName({ username: null, bot: false, botReasons: ['keyword:curl'] })).toBe('爬虫');
    // 普通未登录访客：没有任何判定理由 → 游客
    expect(logUserName({ username: null, bot: false, botReasons: [] })).toBe('游客');
    expect(logUserName({ username: '   ', bot: false, botReasons: [] })).toBe('游客');
    expect(logUserName(null)).toBe('游客');
    expect(isAnonymous(null)).toBe(true);
    expect(isAnonymous('admintest')).toBe(false);
  });

  it('showsBotLabel：「爬虫」只出现在「未登录 + 有判定依据」的行上', () => {
    expect(showsBotLabel({ username: null, bot: true, botReasons: ['headless'] })).toBe(true);
    expect(showsBotLabel({ username: null, bot: false, botReasons: ['overseas'] })).toBe(true);
    expect(showsBotLabel({ username: null, bot: false, botReasons: [] })).toBe(false);
    expect(showsBotLabel(null)).toBe(false);
    // 登录用户的判定徽标走标签行，不占用户名位置
    expect(showsBotLabel({ username: 'admintest', bot: true, botReasons: ['headless'] })).toBe(false);
  });

  it('IP + 地理标签：缺失给占位，同名项去重', () => {
    expect(formatIpCell({ ip: '1.2.3.4', country: '美国', region: 'California', city: 'Los Angeles' })).toBe(
      '1.2.3.4 · 美国 · California · Los Angeles',
    );
    // 直辖市 / 城邦的 region 与 city 同名：不显示成「上海 · 上海」
    expect(formatIpCell({ ip: '1.2.3.4', country: '中国', region: '上海', city: '上海' })).toBe('1.2.3.4 · 中国 · 上海');
    expect(formatIpCell({ ip: null, country: null, region: null, city: null })).toBe(MISSING);
    expect(formatIpCell({ ip: null, country: '美国', region: null, city: null })).toBe(`${MISSING} · 美国`);
    expect(formatIpCell(undefined)).toBe(MISSING);
  });

  it('完整 UA 不截断；空 UA 给占位文案', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    expect(formatUa(ua)).toBe(ua);
    expect(formatUa('')).toBe('（无 UA）');
    expect(formatUa(null)).toBe('（无 UA）');
  });
});

describe('浏览器环境详情行', () => {
  it('全字段：平台 / 语言 / 时区 / 屏幕 / 视口 / 核心 / 内存 / 触控 / 厂商', () => {
    const rows = clientEnvRows({
      platform: 'Win32',
      language: 'zh-CN',
      languages: 'zh-CN,zh,en',
      timezone: 'Asia/Shanghai',
      screen: '1920x1080',
      viewport: '1280x720',
      dpr: 2,
      cores: 8,
      memory: 8,
      touch: 0,
      vendor: 'Google Inc.',
      cookie: true,
    });
    expect(rows).toEqual([
      { key: 'admin.envPlatform', value: 'Win32' },
      { key: 'admin.envLang', value: 'zh-CN (zh-CN,zh,en)' },
      { key: 'admin.envTz', value: 'Asia/Shanghai' },
      { key: 'admin.envScreen', value: '1920x1080 @2x' },
      { key: 'admin.envViewport', value: '1280x720' },
      { key: 'admin.envCores', value: '8' },
      { key: 'admin.envMemory', value: '8 GB' },
      { key: 'admin.envTouch', value: '0' },
      { key: 'admin.envVendor', value: 'Google Inc.' },
      { key: 'admin.envCookie', value: 'true' },
    ]);
  });

  it('languages 只有一项时不重复拼两遍', () => {
    const rows = clientEnvRows({ language: 'zh-CN', languages: 'zh-CN' });
    expect(rows).toEqual([{ key: 'admin.envLang', value: 'zh-CN' }]);
  });

  it('webdriver 只在 true 时出现（正常用户每行都渲染 false 只会淹没可疑记录）', () => {
    const bot = clientEnvRows({ webdriver: true });
    expect(bot).toEqual([{ key: 'admin.envWebdriver', value: 'true' }]);
    expect(clientEnvRows({ webdriver: false })).toEqual([]);
    // cookie 是布尔就直接给原值（false 也是有信息的：禁用 Cookie 的客户端很可疑）
    expect(clientEnvRows({ cookie: false })).toEqual([{ key: 'admin.envCookie', value: 'false' }]);
  });

  it('缺字段 / env 为 null：不产出空行，也不抛错', () => {
    expect(clientEnvRows(null)).toEqual([]);
    expect(clientEnvRows(undefined)).toEqual([]);
    expect(clientEnvRows({})).toEqual([]);
    // 空白字符串不算读数
    expect(clientEnvRows({ platform: '   ', vendor: '' })).toEqual([]);
    // 脏数字（NaN / Infinity）不进详情
    expect(clientEnvRows({ cores: Number.NaN, memory: Number.POSITIVE_INFINITY, dpr: Number.NaN })).toEqual([]);
    expect(clientEnvRows({ screen: '1920x1080', dpr: Number.NaN })).toEqual([{ key: 'admin.envScreen', value: '1920x1080' }]);
  });
});

describe('游玩条目', () => {
  it('来源：start / tab 各自有文案，未知原样显示', () => {
    expect(playSourceLabel('start')).toBe('开始按钮');
    expect(playSourceLabel('tab')).toBe('Tab 重置');
    expect(playSourceLabel('swipe')).toBe('swipe');
    expect(playSourceLabel(null)).toBe(MISSING);
  });

  it('模式名复用 capabilities 的唯一来源；未知模式原样显示', () => {
    expect(playModeLabel('self')).toBe(modeTitle('self'));
    expect(playModeLabel('self')).toBe('输入模式');
    expect(playModeLabel('puzzle')).toBe('拼图模式');
    expect(playModeLabel('brand_new_mode')).toBe('brand_new_mode');
    expect(playModeLabel('')).toBe(MISSING);
    expect(playModeLabel(null)).toBe(MISSING);
  });

  it('未登录的游玩条目显示「游客1234」而不是「未登录」（2026-10 需求 5）', () => {
    expect(playUserName({ username: 'admintest', bot: false })).toBe('admintest');
    expect(playUserName({ username: null, bot: false, visitor: '1234' })).toBe('游客1234');
    expect(playUserName({ username: null, bot: true, visitor: '1234' })).toBe('爬虫1234');
    // 编号缺失（老行/无痕）退化成不带编号的词根
    expect(playUserName({ username: null, bot: false, visitor: null })).toBe('游客');
    // 与日志同一套口径
    expect(logUserName({ username: null, bot: false, botReasons: [], visitor: '1234' })).toBe('游客1234');
  });

  it('出题范围：优先展示名，老行退化成哨兵，两者都缺给占位', () => {
    expect(playScopeLabel({ scopeLabel: '世界', scopeProvince: '__world_nation__' })).toBe('世界');
    expect(playScopeLabel({ scopeLabel: null, scopeProvince: '__province_nation__' })).toBe('__province_nation__');
    expect(playScopeLabel({ scopeLabel: '  ', scopeProvince: '' })).toBe(MISSING);
    expect(playScopeLabel(null)).toBe(MISSING);
  });
});
