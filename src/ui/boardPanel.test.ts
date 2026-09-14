import { describe, it, expect, afterEach, vi } from 'vitest';
import { BoardPanel } from './boardPanel';
import { saveDraft, loadDraft, BOARD_DRAFT_KEY } from './boardDraft';
import type { AuthStore } from '../authStore';
import type { AuthPanel } from './authPanel';
import type { BoardStore } from '../boardStore';
import type { BoardPost, BoardReply } from '../api';
import type { AuthUser } from '../types';

/**
 * 留言板「未登录 → 登录/注册 → 直接发布」的行为约束（2026-09 用户报的缺陷）。
 *
 * 缺陷回顾：未登录点「发帖」时，草稿只存在于 DOM 输入框里，而登录成功后的回调会重绘整个面板
 * （`el.innerHTML = …`）—— DOM 连同输入框里的内容一起被擦掉，用户只能重写。
 *
 * 这里用一个**模拟真实重绘语义**的假 DOM：`innerHTML` 一被赋值，此前的子元素（含 textarea）
 * 就全部失效（与浏览器一致）。于是「草稿没保住」这件事在测试里会真的复现 —— 早期版本的实现
 * 跑这个测试会挂在「登录后输入框空了 / createPost 从未被调用」上。
 */

interface FakeEl {
  value: string;
  textContent: string;
  innerHTML: string;
  parentElement: FakeEl | null;
  handlers: Map<string, () => void>;
  classList: { add: () => void; remove: () => void; toggle: () => void; contains: () => boolean };
  addEventListener: (type: string, fn: () => void) => void;
  click: () => void;
  querySelector: (sel: string) => FakeEl | null;
  querySelectorAll: () => FakeEl[];
}

function fakeEl(): FakeEl {
  const el: FakeEl = {
    value: '',
    textContent: '',
    innerHTML: '',
    parentElement: null,
    handlers: new Map<string, () => void>(),
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    addEventListener(type, fn) {
      el.handlers.set(type, fn);
    },
    click() {
      el.handlers.get('click')?.();
    },
    querySelector: (sel) => (sel.includes('reply-content') ? replyBox : null),
    querySelectorAll: () => [],
  };
  return el;
}

let replyBox: FakeEl | null = null;

/** 假容器：innerHTML 赋值会清空注册表（= 重绘把输入框内容冲掉），并记下最后一次渲染的 HTML。 */
function fakeRoot() {
  const registry = new Map<string, FakeEl>();
  let html = '';
  const root = fakeEl() as FakeEl & { el: (id: string) => FakeEl; html: () => string };
  root.el = (id: string) => {
    if (!registry.has(id)) registry.set(id, fakeEl());
    return registry.get(id)!;
  };
  root.html = () => html;
  Object.defineProperty(root, 'innerHTML', {
    get: () => html,
    set: (v: string) => {
      html = v;
      registry.clear(); // 重绘：旧的 DOM 节点（含 textarea）全部作废
      replyBox = null;
    },
  });
  root.querySelector = (sel: string) => {
    const reply = /\[data-action="submit-reply"\]\[data-post="(\d+)"\]/.exec(sel);
    if (reply) {
      // 同一份 DOM 里重复查询应拿到同一个回复框（重绘才会换新的）
      if (!replyBox) {
        const btn = fakeEl();
        const wrap = fakeEl();
        replyBox = fakeEl();
        wrap.querySelector = () => replyBox;
        btn.parentElement = wrap;
        return btn;
      }
      const btn = fakeEl();
      const wrap = fakeEl();
      wrap.querySelector = () => replyBox;
      btn.parentElement = wrap;
      return btn;
    }
    return sel.startsWith('#') ? root.el(sel.slice(1)) : null;
  };
  return root;
}

function makePanel(opts: { user?: AuthUser | null; failPost?: boolean } = {}) {
  const root = fakeRoot();
  // 容器元素就是同一个假根（BoardPanel 构造函数用 document.getElementById('board') 取它）
  vi.stubGlobal('document', { getElementById: (id: string) => (id === 'board' ? root : root.el(id)) });
  // toast 用 window.setTimeout（node 测试环境没有 window）
  vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });

  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });

  const loginRequests: (() => void)[] = [];
  const createPost = vi.fn(async (_token: string, content: string) => ({ id: 1, content } as BoardPost));
  const createReply = vi.fn(async (_token: string, postId: number, content: string) => ({ id: 1, postId, content } as BoardReply));
  if (opts.failPost) createPost.mockRejectedValueOnce(new Error('network'));

  const posts: BoardPost[] = [];
  const boardStore = {
    refresh: async () => {},
    getPosts: () => posts,
    isExpanded: () => false,
    getExpandedReplies: () => null,
    collapseReplies: () => {},
    loadMore: async () => {},
    expandReplies: async () => {},
    createPost,
    createReply,
    deletePost: async () => {},
    deleteReply: async () => {},
  } as unknown as BoardStore;

  let user = opts.user === undefined ? null : opts.user;
  const auth = {
    currentUser: () => user,
    sessionToken: () => (user ? 'token-1' : null),
  } as unknown as AuthStore;
  const authPanel = {
    requestLogin: (then?: () => void) => {
      if (then) loginRequests.push(then);
    },
  } as unknown as AuthPanel;

  const panel = new BoardPanel('board', boardStore, auth, authPanel);
  return {
    panel,
    root,
    store,
    createPost,
    createReply,
    loginRequests,
    login: () => {
      user = { username: 'u', password: { algorithm: 'PBKDF2-SHA-256', salt: '', hash: '', iterations: 1 }, hometown: null, avatar: null, createdAt: 0, updatedAt: 0 };
      // 登录成功：authPanel 会回调挂起的续发逻辑
      for (const then of loginRequests.splice(0)) then();
    },
    /** 模拟「切换模式再回来」/「刷新页面后再次进入留言板」。 */
    reopen: async () => {
      await panel.show();
    },
    type: (text: string) => {
      const textarea = root.el('board-new-content');
      textarea.value = text;
      textarea.handlers.get('input')?.();
    },
    submit: () => root.el('board-new-submit').click(),
    /** 回复框（由假 DOM 在首次查询回复按钮时创建）。 */
    replyBox: () => {
      root.querySelector('[data-action="submit-reply"][data-post="1"]');
      return replyBox!;
    },
    html: () => root.html(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('未登录发布 → 登录后直接发布', () => {
  it('点发布被拦下：走登录门控，内容存进草稿（不丢）', async () => {
    const h = makePanel();
    await h.panel.show();
    h.type('我的第一条留言');
    h.submit();

    expect(h.createPost).not.toHaveBeenCalled();
    expect(h.loginRequests).toHaveLength(1);
    expect(loadDraft()).toBe('我的第一条留言');
  });

  it('登录成功：**自动**用刚才的内容发布，不再要求用户重写', async () => {
    const h = makePanel();
    await h.panel.show();
    h.type('我的第一条留言');
    h.submit();
    h.login();

    await vi.waitFor(() => expect(h.createPost).toHaveBeenCalledTimes(1));
    expect(h.createPost).toHaveBeenCalledWith('token-1', '我的第一条留言');
    await vi.waitFor(() => expect(loadDraft()).toBe('')); // 发布成功才清草稿
  });

  it('注册路径同样自动发布（authPanel 的登录/注册共用同一个回调）', async () => {
    const h = makePanel();
    await h.panel.show();
    h.type('注册后直接发的留言');
    h.submit();
    h.login();
    await vi.waitFor(() => expect(h.createPost).toHaveBeenCalledWith('token-1', '注册后直接发的留言'));
  });

  it('放弃登录（关掉登录面板）：草稿留在输入框，回来还能接着发', async () => {
    const h = makePanel();
    await h.panel.show();
    h.type('写了一半');
    h.submit();
    h.loginRequests.length = 0; // 用户关掉登录面板 = 回调被丢弃

    await h.reopen(); // 切模式/刷新后重新进入留言板
    // 假 DOM 不解析 HTML，故断言"重绘出来的 HTML 里带着草稿"（真实浏览器里就是输入框的值）
    expect(h.html()).toContain('写了一半');
    expect(loadDraft()).toBe('写了一半');
  });

  it('登录成功但发布失败：草稿保留并回填到输入框，用户可重试', async () => {
    const h = makePanel({ failPost: true });
    await h.panel.show();
    h.type('会被网络打断的留言');
    h.submit();
    h.login();

    await vi.waitFor(() => expect(h.createPost).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(loadDraft()).toBe('会被网络打断的留言')); // 没被清掉
    expect(h.html()).toContain('会被网络打断的留言'); // 且已回填
  });

  it('已登录用户：直接发布，不经过登录门控', async () => {
    const h = makePanel({
      user: { username: 'u', password: { algorithm: 'PBKDF2-SHA-256', salt: '', hash: '', iterations: 1 }, hometown: null, avatar: null, createdAt: 0, updatedAt: 0 },
    });
    await h.panel.show();
    h.type('直接发布');
    h.submit();

    await vi.waitFor(() => expect(h.createPost).toHaveBeenCalledTimes(1));
    expect(h.loginRequests).toHaveLength(0);
    await vi.waitFor(() => expect(loadDraft()).toBe(''));
  });

  it('空内容（只有空白）不触发登录门控，也不发帖', async () => {
    const h = makePanel();
    await h.panel.show();
    h.type('   ');
    h.submit();
    expect(h.loginRequests).toHaveLength(0);
    expect(h.createPost).not.toHaveBeenCalled();
  });

  it('草稿随打随存：即便从未点过发布，切换模式/刷新也不会丢', async () => {
    const h = makePanel();
    await h.panel.show();
    h.type('还没想好发不发');
    expect(h.store.get(BOARD_DRAFT_KEY)).toBe('还没想好发不发');
    await h.reopen();
    expect(h.html()).toContain('还没想好发不发');
  });

  it('回填的草稿会被转义（不因为草稿里有 HTML 而注入）', async () => {
    const h = makePanel();
    saveDraft('<img src=x onerror=alert(1)>');
    await h.panel.show();
    const html = h.html();
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });
});

describe('回复：同样「登录后直接发布」', () => {
  it('未登录发回复 → 登录成功后自动发出去', async () => {
    const h = makePanel();
    await h.panel.show();
    h.replyBox().value = '一条回复';
    (h.panel as unknown as { submitReply: (id: number) => void }).submitReply(1);

    expect(h.createReply).not.toHaveBeenCalled();
    expect(h.loginRequests).toHaveLength(1);
    h.login();
    await vi.waitFor(() => expect(h.createReply).toHaveBeenCalledWith('token-1', 1, '一条回复'));
  });
});
