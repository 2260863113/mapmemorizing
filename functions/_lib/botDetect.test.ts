import { describe, it, expect } from 'vitest';
import { BOT_KEYWORDS, classifyClient } from './botDetect';

/**
 * 爬虫/自动化判定。
 *
 * 为什么必须测：这是需求 3 的**全部判定逻辑**，而且两类错误都不容易在页面上看出来 ——
 *   · 漏判：真实爬虫混在日志里，看着跟真人一样（线上曾出现 4 条 HeadlessChrome、14 条
 *     meta-externalagent，靠人工翻 UA 才发现）；
 *   · 误判：真人被标成「爬虫」，管理端从此不再可信。
 * 所以用例分两半：**线上真实出现过的爬虫 UA 必须命中**，以及**已知的真人 UA（含 App 内置
 * 外壳）必须不命中**。
 *
 * UA 字符串全部按生产库里的原文（含 `HeadlessChrome` 同时带 `Edg/` 这种"伪装成正常浏览器"的组合）。
 */

/** 线上真实出现过的爬虫/自动化 UA（次数见任务描述）。 */
const REAL_CRAWLER_UAS: ReadonlyArray<readonly [string, string]> = [
  [
    'headlesschrome + edg 伪装（4 次）',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0',
  ],
  ['headlesschrome（2 次）', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.7778.96 Safari/537.36'],
  ['headlesschrome（1 次）', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36'],
  [
    'meta-externalagent（14+11+2 次）',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))',
  ],
  ['bingbot（6+1 次）', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
  ['Applebot（2 次）', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)'],
  ['360Spider（4 次）', 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36 Edg/140.0.0.0; 360Spider'],
  ['WindowsPowerShell（1 次）', 'Mozilla/5.0 (Windows NT; Windows NT 10.0; zh-CN) WindowsPowerShell/5.1.26100.9168'],
];

/** 线上真实出现过的真人 UA（**不可误判**）。 */
const REAL_HUMAN_UAS: ReadonlyArray<readonly [string, string]> = [
  ['最新 Chrome（Windows）', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'],
  ['最新 Chrome + Edg（Windows）', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0'],
  ['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'],
  ['微信 iOS（MicroMessenger）', 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN'],
  [
    '微信 Android（XWEB，内嵌 Chrome/107）',
    'Mozilla/5.0 (Linux; Android 13; PGT-AN00 Build/TP1A.220905.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.141 Mobile Safari/537.36 XWEB/1160 MMWEBSDK/20240301 MicroMessenger/8.0.49.2600(0x2800313D) WeChat/arm64',
  ],
  [
    'baiduboxapp（内嵌 Chrome/97，旧版本规则必须豁免）',
    'Mozilla/5.0 (Linux; Android 13; V2254A Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/97.0.4692.98 Mobile Safari/537.36 baiduboxapp/13.30.0.10',
  ],
  [
    'BingSapphire（Bing App 内置浏览器，真人）',
    'Mozilla/5.0 (Linux; Android 13; SM-S9080 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/108.0.5359.128 Mobile Safari/537.36 BingSapphire/32.6.410623902',
  ],
];

describe('classifyClient · 线上真实爬虫 UA 必须命中', () => {
  for (const [name, ua] of REAL_CRAWLER_UAS) {
    it(name, () => {
      const verdict = classifyClient({ ua, country: 'CN' });
      expect(verdict.bot).toBe(true);
      expect(verdict.reasons.length).toBeGreaterThan(0);
      expect(verdict.overseas).toBe(false);
    });
  }

  it('headless 单独成标签（前端要显示「无头浏览器」而不是一串关键词）', () => {
    const verdict = classifyClient({ ua: REAL_CRAWLER_UAS[0][1] });
    expect(verdict.reasons).toContain('headless');
    expect(verdict.reasons).toContain('keyword:headlesschrome');
  });

  it('bingbot / Applebot / 360Spider / meta-externalagent 各有专属关键词，而不只是泛化的 bot', () => {
    const byKeyword = (ua: string, keyword: string) => classifyClient({ ua }).reasons.includes(`keyword:${keyword}`);
    expect(byKeyword(REAL_CRAWLER_UAS[4][1], 'bingbot')).toBe(true);
    expect(byKeyword(REAL_CRAWLER_UAS[5][1], 'applebot')).toBe(true);
    expect(byKeyword(REAL_CRAWLER_UAS[6][1], 'spider')).toBe(true);
    expect(byKeyword(REAL_CRAWLER_UAS[3][1], 'meta-externalagent')).toBe(true);
    expect(byKeyword(REAL_CRAWLER_UAS[3][1], 'crawler')).toBe(true);
  });

  it('powershell：本机脚本伪装成浏览器（WindowsPowerShell/5.1）', () => {
    const verdict = classifyClient({ ua: REAL_CRAWLER_UAS[7][1] });
    expect(verdict.bot).toBe(true);
    expect(verdict.reasons).toContain('keyword:powershell');
  });

  it('360Spider 同时命中 Edg/140 与 360Spider：不会被"版本够新"洗白', () => {
    const verdict = classifyClient({ ua: REAL_CRAWLER_UAS[6][1] });
    expect(verdict.reasons).toContain('keyword:spider');
    expect(verdict.reasons).not.toContain('old_browser'); // Edg/140 不算旧，但它是爬虫
  });
});

describe('classifyClient · 真人 UA 不可误判', () => {
  for (const [name, ua] of REAL_HUMAN_UAS) {
    it(name, () => {
      const verdict = classifyClient({ ua, country: 'CN' });
      expect(verdict.reasons).toEqual([]);
      expect(verdict.bot).toBe(false);
    });
  }

  it('baiduboxapp / 微信 / BingSapphire 内嵌的旧 Chrome 被豁免，不产生 old_browser', () => {
    for (const [, ua] of REAL_HUMAN_UAS.slice(3)) {
      expect(classifyClient({ ua }).reasons).not.toContain('old_browser');
    }
  });

  it('CUBOT 手机（UA 里含 "bot" 子串）不是爬虫：裸 bot 关键词必须避开这个误伤', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 13; CUBOT X20 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
    const verdict = classifyClient({ ua });
    expect(verdict.bot).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it('国内 Android WebView（无外壳 token）不被判爬虫', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; PJD110 Build/UKQ1.230924.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36';
    expect(classifyClient({ ua }).bot).toBe(false);
  });
});

describe('classifyClient · 版本过旧（old_browser）', () => {
  const uaOf = (engine: string) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ${engine} Safari/537.36`;

  it('Chrome/Edg/Firefox 低于 100、Safari 低于 14 判旧', () => {
    for (const engine of ['Chrome/85.0.4183.121', 'Edg/92.0.902.73', 'Firefox/78.0']) {
      const verdict = classifyClient({ ua: uaOf(engine) });
      expect(verdict.reasons, engine).toContain('old_browser');
      expect(verdict.bot, engine).toBe(true);
    }
    const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.3 Safari/605.1.15';
    expect(classifyClient({ ua: safari }).reasons).toContain('old_browser');
  });

  it('恰好到阈值就不算旧（Chrome/100、Safari/14）', () => {
    expect(classifyClient({ ua: uaOf('Chrome/100.0.4896.127') }).reasons).not.toContain('old_browser');
    const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15';
    expect(classifyClient({ ua: safari }).reasons).not.toContain('old_browser');
  });

  it('`Safari/605.1.15` 是 WebKit 版本，不能拿来当 Safari 主版本比（否则每条 iPhone UA 都被判旧）', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1';
    // iOS 12 确实旧 → 判 old_browser；但若实现误读 `Safari/604.1`，这里会变成 604 ≥ 14 的漏判，
    // 故同时断言"没有 Version 的纯 WebKit UA 不产生版本结论"
    expect(classifyClient({ ua }).reasons).toContain('old_browser');
    const noVersion = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_6) AppleWebKit/601.7.7 (KHTML, like Gecko) Safari/601.7.7';
    expect(classifyClient({ ua: noVersion }).reasons).not.toContain('old_browser');
  });

  it('Edg/OPR 的 UA 里也有 Chrome/：先比外壳版本，不拿内嵌 Chromium 的数量级去比（OPR/78 判旧）', () => {
    expect(classifyClient({ ua: uaOf('Chrome/118.0.0.0 Safari/537.36 OPR/104.0.0.0') }).reasons).not.toContain('old_browser');
    expect(classifyClient({ ua: uaOf('Chrome/91.0.4472.124 OPR/77.0.4054.203') }).reasons).toContain('old_browser');
  });

  it('完全认不出浏览器家族（无版本号）时不判旧：宁可漏判也不误杀', () => {
    for (const ua of ['', 'Mozilla/5.0 (unknown platform)', null, undefined]) {
      expect(classifyClient({ ua }).reasons).not.toContain('old_browser');
    }
  });
});

describe('classifyClient · automation 与 webdriver', () => {
  it('puppeteer/playwright/selenium 关键词 → automation', () => {
    for (const token of ['Puppeteer/21.0', 'Playwright/1.40', 'Selenium/4.0']) {
      const verdict = classifyClient({ ua: `Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0 ${token}` });
      expect(verdict.reasons, token).toContain('automation');
      expect(verdict.bot, token).toBe(true);
    }
  });

  it('`navigator.webdriver === true` → automation（UA 完全正常也要判）', () => {
    const verdict = classifyClient({ ua: REAL_HUMAN_UAS[0][1], env: { webdriver: true, platform: 'Win32' } });
    expect(verdict.reasons).toContain('automation');
    expect(verdict.bot).toBe(true);
  });

  it('`webdriver === false` 或缺省不产生 automation（正常浏览器的不变量）', () => {
    expect(classifyClient({ ua: REAL_HUMAN_UAS[0][1], env: { webdriver: false } }).reasons).toEqual([]);
    expect(classifyClient({ ua: REAL_HUMAN_UAS[0][1], env: {} }).reasons).toEqual([]);
    expect(classifyClient({ ua: REAL_HUMAN_UAS[0][1], env: null }).reasons).toEqual([]);
  });
});

describe('classifyClient · 境外 IP', () => {
  it('country 存在且非 CN → overseas；但**不**因此判爬虫（境外有真人）', () => {
    const verdict = classifyClient({ ua: REAL_HUMAN_UAS[0][1], country: 'US' });
    expect(verdict.overseas).toBe(true);
    expect(verdict.reasons).toEqual(['overseas']);
    expect(verdict.bot).toBe(false);
  });

  it('CN 与"不知道"都不算境外（本地 dev 没有 request.cf，不能一律当境外）', () => {
    for (const country of ['CN', 'cn', ' cn ', '', null, undefined]) {
      const verdict = classifyClient({ ua: REAL_HUMAN_UAS[0][1], country });
      expect(verdict.overseas, String(country)).toBe(false);
      expect(verdict.reasons, String(country)).toEqual([]);
    }
  });

  it('境外 + 爬虫关键词时两个标签同时给（管理端才能区分"境外真人"与"境外爬虫"）', () => {
    const verdict = classifyClient({ ua: REAL_CRAWLER_UAS[4][1], country: 'SG' });
    expect(verdict.reasons).toContain('overseas');
    expect(verdict.reasons).toContain('keyword:bingbot');
    expect(verdict.bot).toBe(true);
  });
});

describe('classifyClient · 关键词表', () => {
  it('覆盖需求点名的全部关键词（少一个就等于线上多一类漏判）', () => {
    const required = [
      'headlesschrome', 'headless', 'phantomjs', 'puppeteer', 'playwright', 'selenium',
      'bot', 'spider', 'crawler', 'crawl', 'slurp', 'applebot', 'bingbot', 'googlebot',
      'baiduspider', 'yandex', 'sogou', 'bytespider', 'facebookexternalhit', 'meta-externalagent',
      'semrush', 'ahrefs', 'mj12bot', 'dotbot', 'petalbot', 'gptbot', 'claudebot', 'ccbot',
      'python-requests', 'curl/', 'wget', 'go-http-client', 'java/', 'okhttp', 'axios/',
      'node-fetch', 'scrapy', 'winhttp', 'powershell', 'libwww',
    ];
    for (const keyword of required) expect(BOT_KEYWORDS, keyword).toContain(keyword);
  });

  it('大小写不敏感（UA 大小写不规范也必须命中）', () => {
    expect(classifyClient({ ua: 'Mozilla/5.0 BINGBOT/2.0' }).reasons).toContain('keyword:bingbot');
    expect(classifyClient({ ua: 'curl/8.4.0' }).reasons).toContain('keyword:curl/');
    expect(classifyClient({ ua: 'python-requests/2.31.0' }).reasons).toContain('keyword:python-requests');
    expect(classifyClient({ ua: 'Go-http-client/1.1' }).reasons).toContain('keyword:go-http-client');
  });
});
