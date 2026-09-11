import type { AppData, Unit, Province } from './types';

/**
 * 测试用 AppData 固件。
 *
 * 为什么需要：`AppData` 每加一个地图档字段（本轮的 pro / plus / provincesUltra / provincesPro /
 * provincesPlus），6 处测试固件都要跟着补 5 个 null，否则 tsc 报 TS2739。
 * 集中到这里后，以后加档只改这一处。
 *
 * 注意：本文件只被 *.test.ts 引用，Vite 生产构建的入口是 index.html → main.ts，
 * 不会把测试文件打进 bundle，故不影响产物体积。
 */
export function makeAppData(over: Partial<AppData> = {}): AppData {
  return {
    units: [] as Unit[],
    allUnits: [] as Unit[],
    provinces: [] as Province[],
    // 地级五档
    ultraGeoJson: null,
    proGeoJson: null,
    geoJson: null,
    coarseGeoJson: null, // 历史别名 = pro 档
    plusGeoJson: null,
    losslessGeoJson: null,
    // 省级五档
    provincesGeoJson: null,
    provincesCoarseGeoJson: null, // 历史别名 = ultra 档
    provincesUltraGeoJson: null,
    provincesProGeoJson: null,
    provincesPlusGeoJson: null,
    provincesRawGeoJson: null,
    hkmacGeoJson: null,
    countries: [],
    worldGeoJson: null,
    subregions: [],
    isoSubregion: {},
    ...over,
  };
}
