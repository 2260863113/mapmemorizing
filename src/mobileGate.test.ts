import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CRAWLER_UA_SOURCE,
  DESKTOP_VIEWPORT,
  GATE_CLASS,
  GATE_CONTINUE_VALUE,
  isPhoneClient,
  MOBILE_GATE_KEY,
  PHONE_UA_SOURCE,
} from './mobileGate';
import messages from '../messages.json';

/**
 * 手机端访问门槛（2026-10 需求）。
 *
 * 门槛的**样式与判定内联在 index.html 里**（必须早于主 bundle 生效，理由见 mobileGate.ts 文件头），
 * 所以本文件的核心是**契约断言**：index.html 里的内联副本必须与 `src/mobileGate.ts` 的常量、
 * `messages.json` 的文案逐字一致。改了实现忘了改内联副本 —— 表现是"门槛在线上没弹/弹错文案"，
 * 而单测会把这种静默漂移立刻变红。
 *
 * 另外单测 `isPhoneClient` 的判定本身：这段逻辑的三个条件（不是爬虫、UA 像手机、真有触屏）
 * 每一条都不能少，少一条就会把桌面用户挡住或把手机用户漏掉。
 */

const html = readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');

describe('index.html 的内联门槛与 mobileGate.ts / messages.json 逐字一致', () => {
  it('手机 UA 正则源码一字不差（改了常量却忘了改内联副本会在这里失败）', () => {
    expect(html).toContain(PHONE_UA_SOURCE);
  });

  it('爬虫 UA 正则源码一字不差', () => {
    expect(html).toContain(CRAWLER_UA_SOURCE);
  });

  it('存储键 / 桌面 viewport / 门槛 class / 存储值一字不差', () => {
    expect(html).toContain(MOBILE_GATE_KEY);
    expect(html).toContain(DESKTOP_VIEWPORT);
    expect(html).toContain(`'${GATE_CLASS}'`);
    expect(html).toContain(`'${GATE_CONTINUE_VALUE}'`);
  });

  it('两句文案与 messages.json 一致（内联脚本不能 import 文案表，故必须比对）', () => {
    expect(html).toContain(messages['mobileGate.title']);
    expect(html).toContain(messages['mobileGate.continue']);
    expect(messages['mobileGate.title']).toBe('请用电脑端访问');
    expect(messages['mobileGate.continue']).toBe('继续访问');
  });

  it('门槛结构齐备：遮罩、标题、按钮、以及"门槛生效时隐藏 #app"的样式', () => {
    expect(html).toContain('id="mobile-gate"');
    expect(html).toContain('id="mobile-gate-continue"');
    expect(html).toContain('id="mobile-gate-title"');
    expect(html).toContain(`html.${GATE_CLASS} #app { visibility: hidden; }`);
    // viewport 元素由脚本创建（见下一条），所以这里只断言脚本里那个 id 常量在
    expect(html).toContain('viewport-meta');
  });

  /**
   * ⚠ 这一条是一个**真实缺陷**的回归闸门（2026-10，用户在百度 App 里看到"按钮重复且位置不对"）：
   *
   * 原先的写法是静态声明 `width=device-width`、再由脚本改成 `width=1280`。
   * 百度 App 内置浏览器（Android，Chromium 97）在脚本执行前就按 `device-width` 排版并合成了
   * 那些带圆角/阴影的浮动控件图层（`#zoom-pill` / `#btn-help` / `#hkmac-inset`）；视口改成 1280
   * 触发重排后**旧图层没有被失效**，于是在旧的左上角位置留下残影，看起来就是"按钮重复"。
   * （现代 Chromium 会正确失效，所以新版浏览器复现不出来 —— 只有那次真实截图暴露了它。）
   *
   * 现在的要求是：**全程只声明一次 viewport，之后永不修改** —— 所以静态 meta 必须不存在，
   * 由内联脚本用 `createElement('meta')` 一次性创建最终那一个。
   */
  it('viewport 不静态声明、也不被二次修改（防"重排后浮动控件留残影"复发）', () => {
    expect(html).not.toMatch(/<meta[^>]*name\s*=\s*["']viewport["']/i);
    expect(html).not.toMatch(/<meta[^>]*id\s*=\s*["']viewport-meta["']/i);
    expect(html).toContain("document.createElement('meta')");
    expect(html).toContain("meta.name = 'viewport'");
    // 创建之后不允许再改它（改了就是重新引入了那个重排）
    expect(html).not.toContain('viewport-meta\').setAttribute');
    expect(html).not.toMatch(/getElementById\(['"]viewport-meta['"]\)/);
  });

  it('脚本在 <head> 里、且早于任何 SEO/OG meta（否则首屏已经按 device-width 排过一次版）', () => {
    const headEnd = html.indexOf('</head>');
    expect(html.indexOf('GATE_CLASS')).toBeLessThan(headEnd);
    // 「早」的判据：创建 viewport 的那段脚本出现在 <title> 之前
    expect(html.indexOf('GATE_CLASS')).toBeLessThan(html.indexOf('<title>'));
  });
});

describe('isPhoneClient 的三个条件缺一不可', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 16; 2410DPN6CC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/97.0.4692.98 Mobile Safari/537.36 baiduboxapp/15.72.5.10';
  const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0';
  const GOOGLEBOT_MOBILE = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

  it('手机 + 触屏 → 弹门槛', () => {
    expect(isPhoneClient({ userAgent: IPHONE, touch: true, coarsePointer: true })).toBe(true);
    expect(isPhoneClient({ userAgent: ANDROID, touch: true, coarsePointer: false })).toBe(true);
  });

  it('桌面浏览器 → 不弹（即使窗口很窄，UA 也不像手机）', () => {
    expect(isPhoneClient({ userAgent: DESKTOP, touch: false, coarsePointer: false })).toBe(false);
    expect(isPhoneClient({ userAgent: MAC, touch: false, coarsePointer: false })).toBe(false);
  });

  it('触摸屏笔记本（UA 是桌面）→ 不弹：它显示电脑视图本来就是对的', () => {
    expect(isPhoneClient({ userAgent: DESKTOP, touch: true, coarsePointer: true })).toBe(false);
  });

  it('手机 UA 但没有触屏/粗指针（桌面浏览器的移动端模拟）→ 不弹，避免打扰调试', () => {
    expect(isPhoneClient({ userAgent: IPHONE, touch: false, coarsePointer: false })).toBe(false);
  });

  it('爬虫一律不弹：Googlebot 的手机 UA 与普通手机无法区分，而 SEO 要抓正文', () => {
    expect(isPhoneClient({ userAgent: GOOGLEBOT_MOBILE, touch: true, coarsePointer: true })).toBe(false);
    expect(isPhoneClient({ userAgent: `${IPHONE} HeadlessChrome/120.0.0.0`, touch: true, coarsePointer: true })).toBe(false);
  });
});
