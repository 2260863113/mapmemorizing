import * as echarts from 'echarts';
import type { OtherCountryData, RenderState, UnitColor } from '../types';
import type { MapTheme } from './theme';
import type { MapHandlers } from './renderer';
import { otherInsetMapName } from './mapRegistry';

type GeoRegion = NonNullable<echarts.GeoComponentOption['regions']>[number];

export interface OtherInsetDeps {
  /** 当前主题（随明暗/边界色调切换）。 */
  theme(): MapTheme;
  /** 当前渲染状态（着色函数）。 */
  state(): RenderState | null;
  /** 边界深浅（与主图同一档；本档没有独立的深度设置项）。 */
  tone(): 'light' | 'mid' | 'dark';
  /** 主图交互回调（点/悬停小窗里的面时回传那个面自己的编码）。 */
  handlers: MapHandlers;
  /** 面名（= 编码）→ 当前语言下的显示名。 */
  nameOf(code: string): string;
  /** 当前国家的数据（未进入「其他」档为 null）。 */
  country(): OtherCountryData | null;
}

/**
 * 「其他」档的**飞地小窗**（美国阿拉斯加/夏威夷、俄罗斯加里宁格勒）。
 *
 * ## 为什么是"小窗数组"而不是沿用港澳那一个
 *
 * 港澳放大框（`./inset.ts`）是**一个固定窗口**：写死了 adcode（港澳）、地图名（`hkmac`）、
 * 元素 id 与取景。本档需要的是**每个国家 0~N 个**窗口（美国两个、俄罗斯一个、日本加拿大没有），
 * 几何、编码、字体全按国家变。把两者硬合成一个类会让那个已被 3 个验收脚本覆盖的港澳窗口
 * 跟着一起改动 —— 收益只是省几十行样板，代价是给一条已验证的路径引入回归面。
 * 故**刻意分开**（与本项目此前拒绝"渲染器字段级解耦"是同一个判断），但**视觉语言完全一致**：
 * 同样的边框/圆角/底色/阴影（`.inset-window` 与 `#hkmac-inset` 同一套样式）。
 *
 * ## 为什么窗口数量与分组在**数据层**就定好
 *
 * 哪几块算飞地是**构建期的地理判断**（`scripts/fetch-other-admin1.mjs` 的 `insetGroups`），
 * 不是运行时算出来的：渲染器只按 `insetGroup` 分组摆窗口，不做地理推断。
 */
export class OtherInsetWindows {
  private host: HTMLElement | null = null;
  private charts: echarts.ECharts[] = [];
  private cc = '';

  constructor(private deps: OtherInsetDeps) {}

  /** 显示某国的各小窗（国家切换或小窗数量变化时重建；同国重复调用只重绘）。 */
  show(country: OtherCountryData) {
    if (!this.host) this.host = document.getElementById('other-insets');
    if (!this.host) return;
    // 没有飞地的国家（日本/加拿大）要把整块容器收起来，**并释放旧实例**：
    // 只隐藏/清空 DOM 而留着 charts，下一次 `render()` 仍会按"旧实例个数"去索引新国家的
    // `bboxInsets[i]` —— 那个下标是 undefined，读 `[0]` 直接抛异常。实测后果远不止小窗本身：
    // 异常从 ECharts 的渲染里冒出来，穿过 `setOtherCountry` 一路打断外壳的 `afterScopeChange()`，
    // 于是**国家按钮高亮、语言行、占位提示全都停在旧状态**（一个渲染异常伪装成了"点了没反应"）。
    if (country.insetGeoJsons.length === 0) {
      this.disposeCharts();
      this.host.innerHTML = '';
      this.cc = '';
      this.hide();
      return;
    }
    this.host.classList.remove('hidden');
    if (this.cc !== country.meta.cc || this.charts.length !== country.insetGeoJsons.length) {
      this.disposeCharts();
      this.host.innerHTML = '';
      this.cc = country.meta.cc;
      country.insetGeoJsons.forEach((_, i) => {
        const box = document.createElement('div');
        box.className = 'inset-window';
        box.dataset.insetGroup = String(i);
        this.host!.appendChild(box);
        const chart = echarts.init(box);
        chart.on('click', (p) => this.emit((p as { name?: string }).name, 'click'));
        chart.on('mouseover', (p) => this.emit((p as { name?: string }).name, 'hover'));
        chart.on('mouseout', () => this.deps.handlers.onUnitHoverEnd?.());
        this.charts.push(chart);
      });
    } else {
      // 容器曾隐藏（display:none）时画布尺寸可能残留为 0，恢复可见后强制重算
      for (const c of this.charts) c.resize();
    }
    this.render();
  }

  hide() {
    if (!this.host) this.host = document.getElementById('other-insets');
    this.host?.classList.add('hidden');
  }

  resize() {
    for (const c of this.charts) c.resize();
  }

  /** 主图每次重绘后同步刷新小窗着色与标签（切主题、答题反馈都要跟着变）。 */
  render() {
    const country = this.deps.country();
    const state = this.deps.state();
    if (!country || !state) return;
    const theme = this.deps.theme();
    this.charts.forEach((chart, i) => {
      const units = country.units.filter((u) => u.insetGroup === i);
      const bbox = country.bboxInsets[i];
      // 兜底：实例数与小窗数对不上时宁可少画一个窗，也不要抛异常（异常会打断整条 UI 同步链）
      if (!bbox || units.length === 0) return;
      const regions: GeoRegion[] = units.map((u) => {
        const gray = u.decorative === true;
        const color: UnitColor = gray ? 'gray' : state.colorOf(u.code);
        return {
          name: u.code,
          silent: gray,
          itemStyle: {
            areaColor: theme.fill[color],
            borderColor: theme.boundary[this.deps.tone()],
            borderWidth: 0.8,
          },
          emphasis: {
            disabled: gray,
            itemStyle: { areaColor: gray ? theme.fill.gray : theme.emphasis[color] },
            label: { show: false },
          },
          // 小窗里只有一两块地，直接标名字（用户要能一眼看出这是哪儿）
          label: {
            show: true,
            formatter: this.deps.nameOf(u.code),
            color: theme.labelNeutral,
            fontSize: 10,
            fontWeight: 600,
          },
        };
      });
      chart.setOption(
        {
          backgroundColor: 'transparent',
          geo: {
            map: otherInsetMapName(country.meta.cc, i),
            roam: false,
            silent: false,
            // 投影范围钉死为该小窗自己的包围盒（主图用的是"非飞地"那一个，两者不能混）
            boundingCoords: [
              [bbox[0], bbox[1]],
              [bbox[2], bbox[3]],
            ],
            itemStyle: { borderColor: 'rgba(0,0,0,0)', borderWidth: 0 },
            regions,
          },
        } as never,
        { replaceMerge: ['geo'] },
      );
    });
  }

  dispose() {
    this.disposeCharts();
    this.host = null;
  }

  private disposeCharts() {
    for (const c of this.charts) c.dispose();
    this.charts = [];
  }

  private emit(name: string | undefined, kind: 'click' | 'hover') {
    if (!name) return;
    const country = this.deps.country();
    const unit = country?.byCode.get(name);
    // 装饰面（"不考但显示"）在小窗里同样不可交互：点它等于点了空白
    if (!unit || unit.decorative) return;
    if (kind === 'click') this.deps.handlers.onUnitClick(name);
    else this.deps.handlers.onUnitHover?.(name);
  }
}
