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
    // viewport 必须可被脚本改（点「继续访问」后换成桌面宽度）
    expect(html).toContain('id="viewport-meta"');
    expect(html).toContain('name="viewport"');
  });

  it('行尾/大小写这类细节不影响，但缺了整段就该报错（防止有人顺手删掉门槛）', () => {
    expect(html.indexOf('mobile-gate')).toBeGreaterThan(0);
    // 脚本必须在 <head> 里（否则要等到 body 解析完才执行，首屏已经绘制过手机布局）
    const headEnd = html.indexOf('</head>');
    expect(html.indexOf('GATE_CLASS')).toBeLessThan(headEnd);
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
