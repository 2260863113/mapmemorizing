/**
 * 运行时验收探针（仅在 `?probe=1` 时挂载到 window.__probe）。
 *
 * 为什么需要：本轮六条需求里，有四条是**运行时行为**（空白区命中、ECharts silent
 * region、镜头动画、红显时长），单测只能覆盖抽出来的纯函数，覆盖不到「真的点下去
 * 有没有反应」。探针用真实渲染的 ECharts 实例做断言，验收完即弃。
 *
 * 生产路径不受影响：main.ts 只在 location.search 含 probe=1 时动态 import 本模块，
 * Vite 会把它切成独立 chunk，普通用户不会加载。
 */
import type { AppController } from './appController';
import { ROLLBACK_RED_MS } from './modes/mapQuizMode';
import { worldFollowZoom } from './map/renderer';
import { applyIgnoreTiny, ensureTinyCountries } from './tinyCountries';

export function installProbe(app: AppController) {
  const w = window as unknown as { __probe?: Record<string, unknown> };

  /** 从 controller 取出内部对象：这些字段是 private，探针按名读取（仅调试用）。 */
  const anyApp = app as unknown as {
    renderer: unknown;
    clickMode: unknown;
    data: { countries: { iso: string; name: string; center: [number, number] }[]; countryArea: Record<string, number> };
    settings: { ignoreTinyCountries: boolean };
    applyTinyCountrySetting: () => void;
  };
  const renderer = anyApp.renderer as unknown as Record<string, unknown> & {
    setWorldMode: (on: boolean, c: string | null, s: string | null) => void;
    currentContinent: () => string | null;
    currentSubregion: () => string | null;
    setExcludedCountries: (s: Iterable<string>) => void;
    viewOf?: () => { center: number[]; zoom: number };
    focusWorldCountry: (iso: string) => void;
    panWorldCountry: (iso: string) => void;
    animateViewToProbe?: (c: [number, number], z: number) => void;
  };
  const clickMode = anyApp.clickMode as unknown as {
    worldScopedPool: () => { adcode: string }[];
    getWorldGranularity?: () => unknown;
    setWorldGranularity?: (g: unknown) => void;
  };

  const probe = {
    ready: () => !!anyApp.renderer && !!anyApp.data?.countries?.length,

    /** 1. 空白区无交互：下钻亚洲后，其他洲的面必须是「不可交互」。 */
    blankSpaceInert() {
      // 世界面命中判定：从渲染器内部表读（探针只读，不改状态）
      const r = renderer as unknown as {
        worldNameToIso: Map<string, string>;
        worldDecorativeNames: Set<string>;
        worldExcludedNames: Set<string>;
        isoContinent: Map<string, string>;
        isoSubregion: Map<string, string>;
        worldContinent: string | null;
        worldSubregion: string | null;
      };
      // 先把视图切到亚洲（走真实 API，确保 worldFeatureVisible 生效）
      renderer.setWorldMode(true, 'AS', null);

      const evalInteractive = (name: string) => {
        if (r.worldDecorativeNames.has(name) || r.worldExcludedNames.has(name)) return false;
        const iso = r.worldNameToIso.get(name);
        if (!iso) return false;
        return r.isoContinent.get(iso) === r.worldContinent;
      };
      const nameOf = (iso: string) => r.worldNameToIso ? [...r.worldNameToIso.entries()].find(([, i]) => i === iso)?.[0] ?? '' : '';
      const asianName = nameOf('CHN');
      const euroName = nameOf('FRA');
      const blankResolves = evalInteractive(euroName);
      return {
        continent: r.worldContinent,
        otherContinentInert: evalInteractive(euroName) === false,
        inScopeInteractive: evalInteractive(asianName) === true,
        blankResolvesToVisibleCountry: blankResolves,
        asianName,
        euroName,
      };
    },

    /**
     * 1b. 渲染层验收：下钻后，范围外的面必须**既不可见也不可交互**。
     *
     * 光验事件层不够——如果范围外的面只是「没有外观」但回落到 geo 默认样式，
     * 它们仍会被画成有颜色的国家轮廓（正是用户看到的「看不见却能被高亮的国家」）。
     * 这里直接读回 ECharts 实际生效的 geo.regions，断言范围外的面是
     * 透明 + silent（既不画也不响应）。
     */
    renderedRegions() {
      const r = renderer as unknown as {
        chart: { getOption: () => { geo?: unknown } };
        setWorldMode: (on: boolean, c: string | null, s: string | null) => void;
        render: (s: unknown) => void;
        lastState: unknown;
      };
      r.setWorldMode(true, 'AS', null);
      if (r.lastState) r.render(r.lastState);

      const opt = r.chart.getOption() as { geo?: { regions?: unknown[] }[] | { regions?: unknown[] } };
      const geo = Array.isArray(opt.geo) ? opt.geo[0] : opt.geo;
      const regions = (geo?.regions ?? []) as {
        name?: string;
        silent?: boolean;
        itemStyle?: { areaColor?: string; borderWidth?: number };
      }[];
      const isTransparent = (c?: string) => !c || c === 'rgba(0,0,0,0)' || c === 'transparent';
      // 亚洲的邻洲代表：法国（欧洲）、巴西（南美）、埃及（非洲）；亚洲内：中国
      const pick = (n: string) => regions.find((x) => x.name === n);
      const describe = (n: string) => {
        const g = pick(n);
        return g
          ? { found: true, silent: g.silent === true, transparent: isTransparent(g.itemStyle?.areaColor), areaColor: g.itemStyle?.areaColor }
          : { found: false, silent: false, transparent: false, areaColor: '' };
      };
      const out = { total: regions.length, china: describe('中国'), france: describe('法国'), brazil: describe('巴西') };
      const outOfScopeBlank =
        out.france.found && out.france.silent && out.france.transparent &&
        out.brazil.found && out.brazil.silent && out.brazil.transparent;
      const inScopePainted = out.china.found && !out.china.silent && !out.china.transparent;
      return { ...out, outOfScopeBlank, inScopePainted };
    },

    /** 2. 梵蒂冈：不在池内，但灰面仍在（填住意大利的内部环）。 */
    vatican() {
      const pool = anyApp.data.countries.map((c) => c.iso);
      const r = renderer as unknown as { worldNameToIso: Map<string, string>; worldDecorativeNames: Set<string> };
      const vatName = [...r.worldNameToIso.entries()].find(([, iso]) => iso === 'VAT')?.[0] ?? '';
      return {
        inPool: pool.includes('VAT'),
        count: pool.length,
        faceExists: !!vatName,
        faceIsDecorative: vatName ? r.worldDecorativeNames.has(vatName) : false,
      };
    },

    /** 3. 忽略面积极小的国家：池子缩小且面不可交互。 */
    async tinyCountries() {
      const list = await ensureTinyCountries();
      return { list };
    },
    async toggleTiny(on: boolean) {
      const before = clickMode.worldScopedPool().length;
      const list = await ensureTinyCountries();
      anyApp.settings.ignoreTinyCountries = on;
      applyIgnoreTiny(on, list);
      renderer.setExcludedCountries(new Set(on ? list : []));
      const after = clickMode.worldScopedPool().length;
      const r = renderer as unknown as { worldNameToIso: Map<string, string>; worldExcludedNames: Set<string> };
      const mcoName = [...r.worldNameToIso.entries()].find(([, iso]) => iso === 'MCO')?.[0] ?? '';
      return { poolBefore: before, poolAfter: after, inert: on ? r.worldExcludedNames.has(mcoName) : true, mcoName };
    },

    /**
     * 4. 错误回滚：**真的连答错两次**，观察红格是否两次都亮、以及永久进度是否只记一次。
     *
     * 早期版本用 `answer.toString()` 做源码嗅探，被压缩后必然失效（且本来就不可靠）；
     * 这里改成驱动真实行为，断言的是可观测状态而不是源码文本。
     */
    async rollback() {
      const cm = clickMode as unknown as {
        question: string | null;
        red: Set<string>;
        green: Set<string>;
        results: string[];
        fail: number;
        rollbackCounted: Set<string>;
        rollbacking: boolean;
        errorRollback: boolean;
        answer: (correct: boolean, scored: boolean, timedOut?: boolean) => void;
        persist: () => void;
      };
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
          permanentCountedOnce: afterFirst.fail === afterSecond.fail && afterFirst.redSegments === afterSecond.redSegments,
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

    /** 5. 世界自动跟随：缩放与面积成反比。 */
    worldFollowZoom() {
      const area = anyApp.data.countryArea;
      const pool = anyApp.data.countries.map((c) => c.iso).filter((i) => area[i] > 0);
      const min = Math.min(...pool.map((i) => area[i]));
      const max = Math.max(...pool.map((i) => area[i]));
      const range = { min, max };
      const sgp = worldFollowZoom(area.SGP, range);
      const rus = worldFollowZoom(area.RUS, range);
      const sorted = pool.slice().sort((a, b) => area[a] - area[b]);
      const zooms = sorted.map((i) => worldFollowZoom(area[i], range));
      let monotonic = true;
      for (let i = 1; i < zooms.length; i++) if (zooms[i] > zooms[i - 1] + 1e-9) monotonic = false;
      return { small: sgp, big: rus, monotonic, countries: pool.length };
    },

    /** 6. 答错后平移到正确答案位置且缩放不变。 */
    async panOnWrong() {
      renderer.setWorldMode(true, null, null);
      const r = renderer as unknown as { zoom: number; center: number[] };
      const readView = () =>
        (renderer.currentGeoView as unknown as () => { center: number[]; zoom: number })?.() ?? {
          center: r.center,
          zoom: r.zoom,
        };
      // 先故意把镜头拉到一个远离目标的位置（走真实动画入口）
      const anyRenderer = renderer as unknown as { animateViewTo: (c: [number, number], z: number) => void };
      anyRenderer.animateViewTo([0, 0], 3);
      await new Promise((res) => setTimeout(res, 900)); // 等跟随动画完成
      const from = readView();
      renderer.panWorldCountry('AUS');
      await new Promise((res) => setTimeout(res, 900));
      const to = readView();
      const aus = anyApp.data.countries.find((c) => c.iso === 'AUS');
      const moved = Math.hypot(to.center[0] - from.center[0], to.center[1] - from.center[1]) > 1;
      const targeted = !!aus && Math.hypot(to.center[0] - aus.center[0], to.center[1] - aus.center[1]) < 25;
      return {
        moved,
        targeted,
        fromCenter: from.center.join(','),
        toCenter: to.center.join(','),
        ausCenter: aus?.center.join(','),
        zoomFrom: from.zoom,
        zoomTo: to.zoom,
      };
    },

    /**
     * 5b. 世界自动跟随的**集成**验证：真的调用 renderer.focusWorldCountry，
     * 看相机是否按面积落位。
     *
     * 与 worldFollowZoom()（纯函数）互补：那个只证明映射单调，这个证明
     * 「输入模式 ask() 真正走到的那条路径」能驱动相机、且落点正确。
     */
    async worldAutoFollow() {
      renderer.setWorldMode(true, null, null);
      const r = renderer as unknown as {
        zoom: number;
        center: number[];
        worldLabelAnchors: Map<string, [number, number]>;
      };
      const readView = () =>
        (renderer.currentGeoView as unknown as () => { center: number[]; zoom: number })?.() ?? {
          center: r.center,
          zoom: r.zoom,
        };
      const shoot = async (iso: string) => {
        // 断言基准取**实际使用的目标点**（标签锚点，主面质心），
        // 而不是 countries.json 的 center —— 对俄罗斯这类大国两者相差很远，
        // 拿 center 断言会误报（曾因此踩过一次）。
        const anchor = r.worldLabelAnchors.get(iso) ?? null;
        renderer.focusWorldCountry(iso);
        await new Promise((res) => setTimeout(res, 1000)); // 等镜头动画结束
        const view = readView();
        const landed = anchor ? Math.hypot(view.center[0] - anchor[0], view.center[1] - anchor[1]) : Number.NaN;
        return { view, anchor, landed };
      };
      const sgp = await shoot('SGP'); // 极小：新加坡
      const rus = await shoot('RUS'); // 极大：俄罗斯
      const chn = await shoot('CHN'); // 中等：中国
      const inRange = (z: number) => z >= 1.5999 && z <= 9.0001;
      const close = (s: { landed: number }) => Number.isFinite(s.landed) && s.landed < 1.5; // 度
      return {
        sgpZoom: sgp.view.zoom,
        rusZoom: rus.view.zoom,
        chnZoom: chn.view.zoom,
        sgpLanded: sgp.landed,
        rusLanded: rus.landed,
        chnLanded: chn.landed,
        cameraMovedOnEach: close(sgp) && close(rus) && close(chn),
        inverse: sgp.view.zoom > chn.view.zoom && chn.view.zoom > rus.view.zoom,
        allInRange: [sgp.view.zoom, rus.view.zoom, chn.view.zoom].every(inRange),
      };
    },

    /** 还原：把视图切回世界全图（探针之间互不污染）。 */
    reset() {
      renderer.setWorldMode(true, null, null);
      return true;
    },
  };

  w.__probe = probe;
}
