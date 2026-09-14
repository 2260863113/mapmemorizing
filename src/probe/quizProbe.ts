/**
 * 测验模式（输入 / 点击）与外壳联动相关的验收探针。
 *
 * 这里的断言大多需要**驱动真实行为**再观察可观测状态：错误回滚要真的连答错两次、
 * 顺序出题要真的跑完整个序列、排行榜收起要真的看 `getComputedStyle` 的可见性。
 * 早期版本用「读源码文本」做嗅探，压缩后必然失效，已全部改成行为驱动。
 *
 * 会话状态的读写一律走 `MapQuizMode.diagnostics()` / `InputMode.orderDiagnostics()`
 * （见 `modes/quizDiagnostics.ts`）；公开 API（`start`/`nextUnit`/`setGranularity` 等）直接调。
 */
import { ROLLBACK_RED_MS } from '../modes/mapQuizMode';
import type { AppDiagnostics } from '../appDiagnostics';

export function quizProbe(a: AppDiagnostics) {
  const { renderer, data, clickMode, selfMode, sidePanel } = a;
  /** 点击模式会话视图（可写：探针构造场景后必须还原）。 */
  const cm = clickMode.diagnostics();
  /** 输入模式会话视图。 */
  const sm = selfMode.diagnostics();
  /** 输入模式独有：顺序出题的 BFS 前沿队列。 */
  const order = selfMode.orderDiagnostics();

  return {
    /**
     * 4. 错误回滚：**真的连答错两次**，观察红格是否两次都亮、以及永久进度是否只记一次。
     */
    async rollback() {
      const prevRollback = cm.errorRollback;
      cm.errorRollback = true; // 强制开启，与用户设置无关
      const target = 'FRA';
      const redAt = () => cm.red.has(target);
      try {
        // ---- 第一次答错 ----
        cm.question = target;
        cm.answer(false, false);
        const firstWrongRed = redAt();
        const afterFirst = {
          fail: cm.fail,
          redSegments: cm.results.filter((r) => r === 'red').length,
          rollbacking: cm.rollbacking,
        };
        // 等回滚计时器把临时红清掉、题目恢复
        await new Promise((r) => setTimeout(r, ROLLBACK_RED_MS + 350));
        const redClearedAfterTimer = !redAt();
        const questionRestored = cm.question === target;
        // ---- 第二次答错（同一题）----
        cm.question = target;
        cm.answer(false, false);
        const secondWrongRed = redAt();
        const afterSecond = {
          fail: cm.fail,
          redSegments: cm.results.filter((r) => r === 'red').length,
        };
        await new Promise((r) => setTimeout(r, ROLLBACK_RED_MS + 350));
        return {
          delayMs: ROLLBACK_RED_MS,
          firstWrongRed,
          secondWrongRed,
          redClearedAfterTimer,
          questionRestored,
          // 永久进度只记一次：fail 与进度红格都不因第二次答错而增加
          permanentCountedOnce:
            afterFirst.fail === afterSecond.fail && afterFirst.redSegments === afterSecond.redSegments,
          failAfterFirst: afterFirst.fail,
          failAfterSecond: afterSecond.fail,
          counted: cm.rollbackCounted.has(target),
        };
      } finally {
        // 还原，避免影响后续探针项与本地进度
        cm.errorRollback = prevRollback;
        cm.red.delete(target);
        cm.results = cm.results.filter((r) => r !== 'red');
        cm.rollbackCounted.delete(target);
        cm.question = null;
        cm.fail = cm.red.size;
        cm.persist();
      }
    },

    /**
     * 7. 顺序模式出的题**必须都在当前地图范围内**（用户报的缺陷）。
     *
     * 做法：把输入模式切到「世界粒度 + 亚洲」，跑完整个顺序序列，逐题断言
     * 该国的配图（大洲）就是当前范围。旧实现在邻居查找时用了 worldPool，
     * 会顺着邻接关系把欧洲/非洲的国家出成题，而地图上并没有显示它们。
     */
    seqScopeRespected() {
      const saved = {
        continent: sm.worldContinent,
        subregion: sm.worldSubregion,
        order: sm.orderMode,
        green: new Set(sm.green),
        red: new Set(sm.red),
      };
      try {
        selfMode.setGranularity('world');
        sm.worldContinent = 'AS';
        sm.worldSubregion = null;
        sm.orderMode = 'sequential';
        sm.green = new Set();
        sm.red = new Set();
        order.lastGreen = null;
        order.bfsQueue = [];
        order.bfsDomain = '';
        const pool = sm.activePool();
        const inScope = new Set(pool.map((u) => u.adcode));
        const asked: string[] = [];
        for (let i = 0; i <= pool.length + 3; i++) {
          const remaining = pool.filter((u) => !sm.green.has(u.adcode) && !sm.red.has(u.adcode));
          if (!remaining.length) break;
          const u = selfMode.nextUnit(pool);
          asked.push(u.adcode);
          sm.green.add(u.adcode);
        }
        const continentOf = new Map(data.countries.map((c) => [c.iso, c.continent]));
        const outOfScope = asked.filter((iso) => !inScope.has(iso));
        const wrongContinent = asked.filter((iso) => continentOf.get(iso) !== 'AS');
        return {
          poolSize: pool.length,
          askedCount: asked.length,
          duplicates: asked.length - new Set(asked).size,
          outOfScopeCount: outOfScope.length,
          outOfScopeSample: outOfScope.slice(0, 6),
          wrongContinentCount: wrongContinent.length,
          wrongContinentSample: wrongContinent.slice(0, 6),
          coveredAll: asked.length === pool.length && new Set(asked).size === pool.length,
        };
      } finally {
        sm.worldContinent = saved.continent;
        sm.worldSubregion = saved.subregion;
        sm.orderMode = saved.order;
        sm.green = saved.green;
        sm.red = saved.red;
        order.lastGreen = null;
        order.bfsQueue = [];
        order.bfsDomain = '';
      }
    },

    /**
     * 8. 开始测验自动收起排行榜、结束（结算/重置）自动展开。
     *
     * 注意「收起」的实现是给 `#side-panel` 加 `collapsed` 类（width:0 +
     * content `visibility:hidden`），而不是给 `#leaderboard` 加 `hidden` ——
     * 所以这里量的是**实际可见性**，不是某一个类名。
     */
    async leaderboardAutoToggle() {
      const snapshot = () => {
        const panel = document.getElementById('side-panel');
        const lb = document.getElementById('leaderboard');
        const content = document.getElementById('side-panel-content');
        const cs = content ? getComputedStyle(content) : null;
        return {
          collapsed: !!panel?.classList.contains('collapsed'),
          leaderboardHidden: !!lb?.classList.contains('hidden'),
          contentVisibility: cs?.visibility ?? '',
          contentOpacity: cs ? Number(cs.opacity) : 0,
        };
      };
      type PanelState = ReturnType<typeof snapshot>;
      const visible = (s: PanelState) =>
        !s.collapsed && !s.leaderboardHidden && s.contentVisibility !== 'hidden' && s.contentOpacity > 0.5;
      const setPanel = (open: boolean) => {
        sidePanel.setLeaderboardOpen(open);
        a.syncModeChrome();
      };
      const settle = () => new Promise((r) => setTimeout(r, 420)); // 等 .24s 过渡结束

      // 基线：先手动置于「展开」，确认收起确实由开始动作触发
      setPanel(true);
      await settle();
      const before = snapshot();
      let started = false;
      let during: PanelState;
      let after: PanelState;
      try {
        cm.start(false);
        started = cm.started === true;
        await settle();
        during = snapshot();
        clickMode.onReset();
        await settle();
        after = snapshot();
      } finally {
        setPanel(true);
      }
      return {
        testActuallyStarted: started,
        visibleBeforeStart: visible(before),
        visibleDuringTest: visible(during!),
        visibleAfterEnd: visible(after!),
        detailBefore: before,
        detailDuring: during!,
        detailAfter: after!,
      };
    },

    /**
     * 当前测验模式的范围快照（只读）：模式 / 粒度 / 范围哨兵 / **出题池大小** / 大洲与次区域。
     * 用于断言「下钻是否真的把范围收窄了」（地图视图与出题范围是两件事，必须分开看）。
     */
    quizScope() {
      const mode = a.current;
      const d = mode?.diagnostics?.();
      return {
        mode: mode?.id ?? null,
        granularity: mode?.getGranularity?.() ?? null,
        scopeProvince: mode?.getScopeProvince?.() ?? null,
        started: mode?.isStarted?.() ?? false,
        poolSize: d ? d.activePool().length : null,
        orderSize: d && Array.isArray(d.order) ? d.order.length : null,
        worldContinent: d?.worldContinent ?? null,
        worldSubregion: d?.worldSubregion ?? null,
        viewProvince: renderer.currentProvince(),
      };
    },
  };
}
