/**
 * ECharts 地图注册表：把数据里的各精细度几何注册成**渲染器按名引用的地图**。
 *
 * 为什么单独成模块：这 14 行原先摊在 `MapRenderer` 构造器的开头，与「建查表」「接事件」
 * 混在一起 —— 但它是纯粹的**声明**：哪个地图名对应哪份几何、档位阈值是多少。
 * 把它独立出来，改精细度阶梯时只需看这一处（阈值本身在 ./tiers.ts）。
 *
 * `as never` 是历史写法：`AppData` 的几何字段类型是 `unknown`，而 ECharts 的
 * `registerMap` 只接受它自己的 GeoJSON 类型。数据由构建脚本产出，形状由
 * `scripts/check-data.mjs` 与 `src/dataTiers.test.ts` 守护。
 */
import * as echarts from 'echarts';
import type { AppData } from '../types';

export function registerMaps(data: AppData) {
  // 地级五档（精细度阶梯 ultra 4% < pro 8% < fine 15% < plus 40% < lossless 100%）
  echarts.registerMap('china-ultra', data.ultraGeoJson as never); // zoom < 2
  echarts.registerMap('china-pro', data.proGeoJson as never); // 2 ≤ zoom < 6
  echarts.registerMap('china', data.geoJson as never); // 6 ≤ zoom < 10（fine 15%）
  echarts.registerMap('china-coarse', data.coarseGeoJson as never); // 历史别名 = pro 档，保留注册避免旧缓存引用
  echarts.registerMap('china-plus', data.plusGeoJson as never); // 10 ≤ zoom < 14
  echarts.registerMap('china-lossless', data.losslessGeoJson as never); // zoom ≥ 14（100% 顶点）
  // 省级五档（与地级同一套阈值）
  echarts.registerMap('china-provinces-ultra', data.provincesUltraGeoJson as never); // zoom < 2
  echarts.registerMap('china-provinces-pro', data.provincesProGeoJson as never); // 2 ≤ zoom < 6
  echarts.registerMap('china-provinces', data.provincesGeoJson as never); // 6 ≤ zoom < 10（fine 15%）
  echarts.registerMap('china-provinces-coarse', data.provincesCoarseGeoJson as never); // 历史别名 = ultra 档
  echarts.registerMap('china-provinces-plus', data.provincesPlusGeoJson as never); // 10 ≤ zoom < 14
  echarts.registerMap('china-provinces-raw', data.provincesRawGeoJson as never); // zoom ≥ 14（100% 顶点）
  echarts.registerMap('world', data.worldGeoJson as never); // 世界地图：答题国 + 装饰面
}
