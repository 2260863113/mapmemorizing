/**
 * 地图 / 镜头 / 世界面相关的运行时验收探针。
 *
 * 这些断言的对象是**真实渲染出来的 ECharts 实例**与**真实相机状态**：
 * 「空白区到底有没有反应」「范围外的面是不是真的既不可见也不可交互」
 * 这类问题，单测里的纯函数覆盖不到。
 *
 * 私有状态的读取一律走 `MapRenderer.diagnostics()`（见 `rendererDiagnostics.ts`），
 * 公开 API 直接调 —— 两者都受编译器保护。
 */
import {
  worldFollowZoom as followZoomFor,
  WORLD_FOLLOW_MAX_ZOOM,
  WORLD_FOLLOW_MIN_ZOOM,
} from '../map/renderer';
import { FOLLOW_MARGIN_RATIO } from '../map/follow';
import { applyIgnoreTiny, ensureTinyCountries } from '../tinyCountries';
import type { AppDiagnostics } from '../appDiagnostics';

export function mapProbe(a: AppDiagnostics) {
  const { renderer, data, settings, clickMode } = a;
  /** 渲染器的只读诊断视图（活值：getter 直接读当前字段）。 */
  const d = renderer.diagnostics();
  /** 点击模式的会话诊断视图（`worldScopedPool` 是 protected）。 */
  const quiz = clickMode.diagnostics();

  /** ECharts 回读的 geo.regions 元素（只取用到的字段）。 */
  type ReadbackRegion = {
    name?: string;
    silent?: boolean;
    itemStyle?: { areaColor?: string; borderColor?: string; borderWidth?: number };
  };

  return {
    /** 1. 空白区无交互：下钻亚洲后，其他洲的面必须是「不可交互」。 */
    blankSpaceInert() {
      // 先把视图切到亚洲（走真实 API，确保 worldFeatureVisible 生效）
      renderer.setWorldMode(true, 'AS', null);

      const evalInteractive = (name: string) => {
        if (d.worldDecorativeNames.has(name) || d.worldExcludedNames.has(name)) return false;
        const iso = d.worldNameToIso.get(name);
        if (!iso) return false;
        return d.isoContinent.get(iso) === d.worldContinent;
      };
      const nameOf = (iso: string) =>
        [...d.worldNameToIso.entries()].find(([, i]) => i === iso)?.[0] ?? '';
      const asianName = nameOf('CHN');
      const euroName = nameOf('FRA');
      return {
        continent: d.worldContinent,
        otherContinentInert: evalInteractive(euroName) === false,
        inScopeInteractive: evalInteractive(asianName) === true,
        blankResolvesToVisibleCountry: evalInteractive(euroName),
        asianName,
        euroName,
      };
    },

    /**
     * 1b. 渲染层验收：下钻后，范围外的面必须**既不可见也不可交互**（默认设置下的口径）。
     *
     * 光验事件层不够——如果范围外的面只是「没有外观」但回落到 geo 默认样式，
     * 它们仍会被画成有颜色的国家轮廓（正是用户看到的「看不见却能被高亮的国家」）。
     * 这里直接读回 ECharts 实际生效的 geo.regions，断言范围外的面是
     * 透明 + silent（既不画也不响应）。
     *
     * 关闭「下钻后隐藏无关地区」后，范围外的面改为**浅灰可见**——此时 `outOfScopeBlank`
     * 应当为 false、`outOfScopeSilent` 仍须为 true（可见性变了，可交互性没变）。
     */
    renderedRegions() {
      renderer.setWorldMode(true, 'AS', null);
      const state = d.lastState;
      if (state) renderer.render(state);

      const opt = d.chart.getOption() as
        | { geo?: { regions?: unknown[] }[] | { regions?: unknown[] } }
        | undefined;
      const geo = Array.isArray(opt?.geo) ? opt.geo[0] : opt?.geo;
      const regions = (geo?.regions ?? []) as ReadbackRegion[];
      const isTransparent = (c?: string) => !c || c === 'rgba(0,0,0,0)' || c === 'transparent';
      // 亚洲的邻洲代表：法国（欧洲）、巴西（南美）；亚洲内：中国
      const pick = (n: string) => regions.find((x) => x.name === n);
      const describe = (n: string) => {
        const g = pick(n);
        return g
          ? {
              found: true,
              silent: g.silent === true,
              transparent: isTransparent(g.itemStyle?.areaColor),
              areaColor: g.itemStyle?.areaColor,
              borderWidth: g.itemStyle?.borderWidth ?? 0,
            }
          : { found: false, silent: false, transparent: false, areaColor: '', borderWidth: 0 };
      };
      const out = {
        total: regions.length,
        china: describe('中国'),
        france: describe('法国'),
        brazil: describe('巴西'),
      };
      const outOfScopeBlank =
        out.france.found && out.france.silent && out.france.transparent &&
        out.brazil.found && out.brazil.silent && out.brazil.transparent;
      const outOfScopeSilent =
        out.france.found && out.france.silent && out.brazil.found && out.brazil.silent;
      const inScopePainted = out.china.found && !out.china.silent && !out.china.transparent;
      return { ...out, setting: d.hideUnrelatedOnDrill, outOfScopeBlank, outOfScopeSilent, inScopePainted };
    },

    /** 2. 梵蒂冈：不在池内，但灰面仍在（填住意大利的内部环）。 */
    vatican() {
      const pool = data.countries.map((c) => c.iso);
      const vatName = [...d.worldNameToIso.entries()].find(([, iso]) => iso === 'VAT')?.[0] ?? '';
      return {
        inPool: pool.includes('VAT'),
        count: pool.length,
        faceExists: !!vatName,
        faceIsDecorative: vatName ? d.worldDecorativeNames.has(vatName) : false,
      };
    },

    /** 3. 忽略面积极小的国家：池子缩小且面不可交互。 */
    async tinyCountries() {
      return { list: await ensureTinyCountries() };
    },

    async toggleTiny(on: boolean) {
      const before = quiz.worldScopedPool().length;
      const list = await ensureTinyCountries();
      settings.ignoreTinyCountries = on;
      applyIgnoreTiny(on, list);
      renderer.setExcludedCountries(new Set(on ? list : []));
      const after = quiz.worldScopedPool().length;
      const mcoName = [...d.worldNameToIso.entries()].find(([, iso]) => iso === 'MCO')?.[0] ?? '';
      return {
        poolBefore: before,
        poolAfter: after,
        inert: on ? d.worldExcludedNames.has(mcoName) : true,
        mcoName,
      };
    },

    /** 5. 世界自动跟随：缩放与面积成反比（含用户标定的三个锚点）。 */
    worldFollowZoom() {
      const area = data.countryArea;
      const pool = data.countries.map((c) => c.iso).filter((i) => area[i] > 0);
      const sorted = pool.slice().sort((x, y) => area[x] - area[y]);
      const zooms = sorted.map((i) => followZoomFor(area[i]));
      let monotonic = true;
      for (let i = 1; i < zooms.length; i++) if (zooms[i] > zooms[i - 1] + 1e-9) monotonic = false;
      // 锚点：立陶宛 → 11x；法国 → 8x；俄罗斯 → 3x
      const anchors: Record<string, { area: number; zoom: number; want: number }> = {};
      for (const [iso, want] of [['LTU', 11], ['FRA', 8], ['RUS', 3]] as [string, number][]) {
        anchors[iso] = { area: area[iso], zoom: followZoomFor(area[iso]), want };
      }
      const anchorsHit = Object.values(anchors).every((x) => Math.abs(x.zoom - x.want) <= 0.15);
      return {
        small: followZoomFor(area.NRU),
        big: followZoomFor(area.RUS),
        monotonic,
        countries: pool.length,
        anchors,
        anchorsHit,
        maxZoom: Math.max(...pool.map((i) => followZoomFor(area[i]))),
      };
    },

    /** 6. 答错后平移到正确答案位置且缩放不变。 */
    async panOnWrong() {
      renderer.setWorldMode(true, null, null);
      const readView = () => d.currentGeoView();

      // 先故意把镜头拉到一个远离目标的位置（走真实动画入口）
      d.animateViewTo([0, 0], 3);
      await new Promise((res) => setTimeout(res, 900)); // 等跟随动画完成
      const from = readView();
      renderer.panWorldCountry('AUS');
      await new Promise((res) => setTimeout(res, 900));
      const to = readView();
      const aus = data.countries.find((c) => c.iso === 'AUS');
      const moved = Math.hypot(to.center[0] - from.center[0], to.center[1] - from.center[1]) > 1;
      const targeted = !!aus && Math.hypot(to.center[0] - aus.center[0], to.center[1] - aus.center[1]) < 25;
      // 新语义（跟随钳制）：被钳制时不再要求正中，改为要求「锚点仍在视口内」；
      // 并且再平移一次 —— 此时澳洲已舒适可见，应当**完全不动**。
      const anchor = d.worldLabelAnchors.get('AUS') ?? null;
      const win = d.viewportWindow();
      const ausVisible =
        !!win && !!anchor &&
        anchor[0] >= win.box[0] && anchor[0] <= win.box[2] &&
        anchor[1] >= win.box[1] && anchor[1] <= win.box[3];
      renderer.panWorldCountry('AUS');
      await new Promise((res) => setTimeout(res, 900));
      const again = readView();
      const stayedStill =
        Math.hypot(again.center[0] - to.center[0], again.center[1] - to.center[1]) < 1e-6 &&
        Math.abs(again.zoom - to.zoom) < 1e-6;
      return {
        moved,
        targeted,
        ausVisible,
        stayedStill,
        fromCenter: from.center.join(','),
        toCenter: to.center.join(','),
        ausCenter: aus?.center.join(','),
        ausAnchor: anchor ? anchor.join(',') : null,
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
      const readView = () => d.currentGeoView();

      const shoot = async (iso: string) => {
        // 断言基准取**实际使用的目标点**（标签锚点，主面质心），
        // 而不是 countries.json 的 center —— 对俄罗斯这类大国两者相差很远，
        // 拿 center 断言会误报（曾因此踩过一次）。
        const anchor = d.worldLabelAnchors.get(iso) ?? null;
        renderer.focusWorldCountry(iso);
        await new Promise((res) => setTimeout(res, 1000)); // 等镜头动画结束
        const view = readView();
        const landed = anchor
          ? Math.hypot(view.center[0] - anchor[0], view.center[1] - anchor[1])
          : Number.NaN;
        // 跟随钳制（2026-09 需求）：贴着取景边界的目标不再被顶到正中，
        // 断言因此从「必然居中」改成「目标仍在视口内 + 内容不越出边界（边距 m 之内算合规）」。
        const extent = d.framingExtent();
        const win = d.viewportWindow();
        const marginPx = win ? Math.min(win.width, win.height) * FOLLOW_MARGIN_RATIO : 0;
        const allowX = win ? marginPx * win.perPxX : 0;
        const allowY = win ? marginPx * win.perPxY : 0;
        const inside =
          !!win && !!anchor &&
          anchor[0] >= win.box[0] && anchor[0] <= win.box[2] &&
          anchor[1] >= win.box[1] && anchor[1] <= win.box[3];
        // 越界量 = 视口超出取景边界的那一段（负值表示视口在边界内，属正常）
        const overrun = win && extent
          ? {
              west: +(extent[0] - win.box[0]).toFixed(2),
              east: +(win.box[2] - extent[2]).toFixed(2),
              south: +(extent[1] - win.box[1]).toFixed(2),
              north: +(win.box[3] - extent[3]).toFixed(2),
            }
          : null;
        const overrunOk = overrun
          ? Math.max(overrun.west, 0) <= allowX + 1e-6 &&
            Math.max(overrun.east, 0) <= allowX + 1e-6 &&
            Math.max(overrun.south, 0) <= allowY + 1e-6 &&
            Math.max(overrun.north, 0) <= allowY + 1e-6
          : false;
        const detail = win && extent && overrun
          ? {
              ...overrun,
              allowX: +allowX.toFixed(2),
              allowY: +allowY.toFixed(2),
              window: win.box.map((v) => +v.toFixed(2)),
              extent,
            }
          : null;
        return { view, anchor, landed, inside, overrunOk, detail };
      };
      const sgp = await shoot('SGP'); // 极小：新加坡
      const rus = await shoot('RUS'); // 极大：俄罗斯（3x，北界贴边 → 会被钳制）
      const chn = await shoot('CHN'); // 中等：中国
      const inRange = (z: number) =>
        z >= WORLD_FOLLOW_MIN_ZOOM - 1e-4 && z <= WORLD_FOLLOW_MAX_ZOOM + 1e-4;
      return {
        sgpZoom: sgp.view.zoom,
        rusZoom: rus.view.zoom,
        chnZoom: chn.view.zoom,
        sgpLanded: sgp.landed,
        rusLanded: rus.landed,
        chnLanded: chn.landed,
        /** 三个样例：目标仍在视口内，且内容没有越出取景边界（边距允许的例外之外） */
        cameraMovedOnEach:
          sgp.inside && rus.inside && chn.inside && sgp.overrunOk && rus.overrunOk && chn.overrunOk,
        eachInside: sgp.inside && rus.inside && chn.inside,
        eachOverrunOk: sgp.overrunOk && rus.overrunOk && chn.overrunOk,
        /** 俄罗斯确实被钳制（锚点约 60°N，而 3x 视口的中心纬度上限约 47°N） */
        rusClamped: rus.landed > 5,
        sgpDetail: sgp.detail,
        rusDetail: rus.detail,
        chnDetail: chn.detail,
        inverse: sgp.view.zoom > chn.view.zoom && chn.view.zoom > rus.view.zoom,
        allInRange: [sgp.view.zoom, rus.view.zoom, chn.view.zoom].every(inRange),
      };
    },

    /** 截图用：跟随某国并回报其面积与算出的倍率（不等待动画，由调用方截图）。 */
    followShot(iso: string) {
      renderer.setWorldMode(true, null, null);
      renderer.focusWorldCountry(iso);
      const area = data.countryArea[iso] ?? 0;
      return { area: Number(area.toFixed(4)), zoom: followZoomFor(area) };
    },

    /** 截图用：把某单位/国家标成「闪烁」高亮（截图里看得见被跟随的目标）。 */
    flashTarget(adcode: string) {
      renderer.flash(adcode);
      return true;
    },

    /** 截图用：可选先下钻某省，再跟随某地级单位（不等待动画，由调用方截图）。 */
    followUnitShot(adcode: string, drill: string | null = null) {
      renderer.setWorldMode(false, null, null);
      renderer.setProvinceMode(false, { inset: false });
      if (drill) renderer.drillToProvince(drill);
      renderer.focusUnit(adcode, 12);
      return { center: d.center.join(','), zoom: d.zoom };
    },

    /** 截图/体检用：当前取景边界与视口数据矩形（跟随钳制的两个输入，只读）。 */
    followFrames() {
      return JSON.stringify({
        extent: d.framingExtent(),
        window: d.viewportWindow(),
        center: d.center,
        zoom: d.zoom,
      });
    },

    /**
     * 9. 全局设置「下钻后隐藏无关地区」—— **当前实际视图**的只读回读（本轮需求）。
     *
     * 为什么必须运行时验：这条需求落在**真正渲染出来的面**与**真正生效的档位**上 ——
     * 「范围外的面到底画没画」「关掉开关后下钻是不是还强制最无损档」，纯函数与单测都只能证明一半。
     *
     * **本方法刻意只读**（不改设置、不改视图）：验收脚本走真实路径
     * 「打开设置面板 → 关掉开关 → 保存」，在保存前后各读一次，就能证明设置**当场生效**，
     * 且拿到省外惰性面的**画布像素**去派发真实指针事件（断言"灰区悬停没有反应"）。
     * 视图没下钻时 `drilledProvince` 为 null，调用方据此判断样本是否有效。
     */
    drillShade() {
      const province = renderer.currentProvince();
      const center = data.provinces.find((p) => p.adcode === province)?.center ?? [113.4, 23.4];
      const inUnit = province
        ? (data.allUnits.find((u) => u.provinceAdcode === province && !u.decorative) ?? null)
        : null;
      // 省外候选：按到本省中心的距离排序取最近的若干（下钻后视口里才可能出现它们）
      const outUnits = province
        ? data.allUnits
            .filter((u) => u.provinceAdcode !== province && !u.decorative)
            .map((u) => ({ u, dist: Math.hypot(u.center[0] - center[0], u.center[1] - center[1]) }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, 12)
            .map((x) => x.u)
        : [];
      const outUnit = outUnits[0] ?? null;

      const opt = d.chart.getOption() as
        | { geo?: { regions?: unknown[] }[] | { regions?: unknown[] } }
        | undefined;
      const geo = Array.isArray(opt?.geo) ? opt.geo[0] : opt?.geo;
      const regions = (geo?.regions ?? []) as ReadbackRegion[];
      /** 某个面**此刻实际生效**的样式（不是我们以为写进去的）。 */
      const describe = (name: string) => {
        if (!name) return { found: false, silent: false, areaColor: '', borderWidth: 0 };
        const r = regions.find((x) => x.name === name);
        return r
          ? {
              found: true,
              silent: r.silent === true,
              areaColor: r.itemStyle?.areaColor ?? '',
              borderWidth: r.itemStyle?.borderWidth ?? 0,
            }
          : { found: false, silent: false, areaColor: '', borderWidth: 0 };
      };
      return {
        setting: d.hideUnrelatedOnDrill,
        drilledProvince: province,
        zoom: d.zoom,
        tier: d.activeTier,
        // 省界线：一项 = 一个环，故数量本身没意义；真正要看的是"画了哪些省"
        provinceLineCount: d.provinceLineAdcodes.length,
        provinceLineProvinces: [...new Set(d.provinceLineAdcodes)].sort(),
        inScope: { adcode: inUnit?.adcode ?? '', name: inUnit?.name ?? '', ...describe(inUnit?.name ?? '') },
        outScope: { adcode: outUnit?.adcode ?? '', name: outUnit?.name ?? '', ...describe(outUnit?.name ?? '') },
        // 候选面的画布像素（脚本再按 canvas 矩形与 elementFromPoint 筛掉打不到画布的点）
        pixels: {
          inScope: inUnit ? { adcode: inUnit.adcode, name: inUnit.name, pixel: d.dataToPixel(inUnit.center) } : null,
          outScope: outUnits.map((u) => ({ adcode: u.adcode, name: u.name, pixel: d.dataToPixel(u.center) })),
        },
      };
    },

    /** 还原：把视图切回世界全图（探针之间互不污染）。 */
    reset() {
      renderer.setWorldMode(true, null, null);
      return true;
    },
  };
}
