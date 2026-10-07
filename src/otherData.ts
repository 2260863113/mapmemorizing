/**
 * 「其他」档（他国一级行政区）的数据加载：清单随启动加载，**几何按国家懒加载**。
 *
 * ## 为什么几何要懒加载
 *
 * 四国几何合计 567KB（美 133 / 加 203 / 日 47 / 俄 183），而一次只练一个国家。
 * 把它们塞进 `loadData()` 会让**每次打开站点**都多拉 567KB —— 比中国地级细档（220KB）还大，
 * 而绝大多数访问根本不碰这个档。故：`index.json`（1KB，四国清单）随启动加载（分段按钮要立刻可点），
 * 具体一国的几何 + 元数据在**用户点那个国家时**才拉（见 `loadOtherCountry`）。
 *
 * ## 为什么把 `properties.name` 改写成 code
 *
 * ECharts 按 GeoJSON 面的 `properties.name` 匹配 region 与 series.data。本档的**显示名随语言变**
 * （中文 / 英语 / 日语 / 俄语），若把显示名当匹配键，切一次语言就得把几何、region、data、
 * 标签锚点全部重算一遍，而且两种语言下重名的风险永远存在。
 * 因此这里统一把 region 名钉成**稳定的编码**（`US-AK`），显示文本一律由 label formatter 现取。
 * 于是"切语言"只影响一个取文本的函数，不动任何几何。
 */
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { t } from './i18n';
import type { OtherCountryCode, OtherCountryData, OtherCountryMeta, OtherUnitMeta } from './types';
import { registerOtherMaps } from './map/mapRegistry';

/** 已加载的国家（按需缓存；与 data.ts 的 `cache` 一样是进程级）。 */
const cache = new Map<OtherCountryCode, OtherCountryData>();

interface OtherUnitsFile {
  cc: OtherCountryCode;
  name: string;
  lang: OtherCountryMeta['lang'];
  units: OtherUnitMeta[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(t('data.loadFail', { url, status: res.status }));
  return res.json() as Promise<T>;
}

/** 四国清单（startup 时由 `loadData` 调用）。 */
export async function loadOtherIndex(): Promise<OtherCountryMeta[]> {
  const file = await fetchJson<{ countries: OtherCountryMeta[] }>('data/other/index.json');
  return file.countries;
}

/** 已加载则直接返回（模式切换时避免重复网络请求与重复展开几何）。 */
export function otherCountryLoaded(cc: OtherCountryCode): OtherCountryData | undefined {
  return cache.get(cc);
}

/** 若干单位的包围盒并集（与构建脚本同一套口径）。 */
function unionBBox(list: OtherUnitMeta[]): [number, number, number, number] {
  return [
    Math.min(...list.map((u) => u.bbox[0])),
    Math.min(...list.map((u) => u.bbox[1])),
    Math.max(...list.map((u) => u.bbox[2])),
    Math.max(...list.map((u) => u.bbox[3])),
  ];
}

/**
 * 按 `insetGroup` 把一国的几何切成"主图 + 每个小窗一份"，并算好各自的投影范围。
 *
 * 切分放在加载处（而不是渲染器里）：渲染器只需要"给我第 i 个小窗的面"，
 * 而切分是一次性成本；且主图/小窗的包围盒口径必须与构建期**完全一致**
 * （构建脚本用同一套并集规则算进 index.json，两处不一致就会出现"投影与实际几何错位"）。
 */
function splitInsets(units: OtherUnitMeta[], geo: { features: { properties: Record<string, unknown> }[] }) {
  const groupCount = units.reduce((m, u) => Math.max(m, (u.insetGroup ?? -1) + 1), 0);
  const bboxInsets: [number, number, number, number][] = [];
  const insetGeoJsons: unknown[] = [];
  for (let g = 0; g < groupCount; g++) {
    const mine = units.filter((u) => u.insetGroup === g);
    bboxInsets.push(unionBBox(mine));
    const keep = new Set(mine.map((u) => u.code));
    insetGeoJsons.push({
      type: 'FeatureCollection',
      features: geo.features.filter((f) => keep.has(String(f.properties.code))),
    });
  }
  return { bboxMain: unionBBox(units.filter((u) => !u.inset)), groupCount, bboxInsets, insetGeoJsons };
}

/**
 * 加载一国（几何 + 元数据）并注册其 ECharts 地图。重复调用走缓存。
 */
export async function loadOtherCountry(cc: OtherCountryCode): Promise<OtherCountryData> {
  const hit = cache.get(cc);
  if (hit) return hit;

  const [topo, file] = await Promise.all([
    fetchJson<Topology>(`data/other/${cc}.topojson`),
    fetchJson<OtherUnitsFile>(`data/other/${cc}.units.json`),
  ]);
  const obj = topo.objects?.[cc] as GeometryCollection | undefined;
  if (!obj) throw new Error(`TopoJSON 缺 objects.${cc}`);
  const geo = feature(topo, obj) as { features: { properties: Record<string, unknown> }[] };
  // region 名 = 编码（理由见文件头）
  for (const f of geo.features) {
    if (typeof f.properties.code === 'string') f.properties.name = f.properties.code;
  }

  const units = file.units;
  const byCode = new Map(units.map((u) => [u.code, u]));
  const pool = units.filter((u) => !u.decorative);
  const { bboxMain, groupCount, bboxInsets, insetGeoJsons } = splitInsets(units, geo);

  registerOtherMaps(cc, geo, insetGeoJsons);

  const data: OtherCountryData = {
    meta: {
      cc,
      name: file.name,
      lang: file.lang,
      count: pool.length,
      decorativeCount: units.length - pool.length,
      inset: groupCount > 0,
      bbox: {
        main: bboxMain,
        insets: bboxInsets.map((bbox, g) => ({
          codes: units.filter((u) => u.insetGroup === g).map((u) => u.code),
          bbox,
        })),
      },
    },
    units,
    pool,
    geoJson: geo,
    insetGeoJsons,
    bboxMain,
    bboxInsets,
    byCode,
  };
  cache.set(cc, data);
  return data;
}
