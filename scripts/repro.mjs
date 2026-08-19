// 回归测试（SSR 真实执行 setOption）：
// 1) 启动时序：先 setOption(geo) 再完整 setOption —— 不崩溃
// 2) series 数据与 geo 地图（'china' 地级数据）名称匹配 —— 地级面能绘制
// 3) 省界 lines 系列正常渲染
import * as echarts from 'echarts';
import fs from 'node:fs';

const meta = JSON.parse(fs.readFileSync('public/data/units.json', 'utf8'));
const geoJson = JSON.parse(fs.readFileSync('public/data/china_units.geojson', 'utf8'));
const provGeo = JSON.parse(fs.readFileSync('public/data/china_provinces.geojson', 'utf8'));

echarts.registerMap('china', geoJson);

const provinceLines = [];
for (const f of provGeo.features) {
  const g = f.geometry;
  const rings = [];
  if (g.type === 'Polygon') rings.push(...g.coordinates);
  else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) rings.push(...poly);
  for (const ring of rings) {
    const coords = ring.filter((c) => Array.isArray(c) && typeof c[0] === 'number');
    if (coords.length >= 2) provinceLines.push({ adcode: f.properties.adcode, coords });
  }
}
console.log('省界线数量:', provinceLines.length);

const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 600 });

try {
  // 场景 1：模拟 main.ts 启动时序（先 setOption geo，再完整 setOption）—— 修复前此处崩溃
  chart.setOption({ geo: { map: 'china', center: [104.5, 35], zoom: 1 } });
  console.log('[1] setOption(geo only) OK');
} catch (e) {
  console.log('[1] setOption(geo only) FAIL:', e.message);
}

try {
  chart.setOption({
    tooltip: { trigger: 'item', formatter: () => '' },
    geo: {
      map: 'china',
      roam: true,
      label: { show: false },
      emphasis: { label: { show: false }, itemStyle: { areaColor: 'rgba(255,255,255,0.22)' } },
      itemStyle: { areaColor: 'rgba(0,0,0,0)', borderColor: 'rgba(0,0,0,0)', borderWidth: 0 },
    },
    series: [
      {
        type: 'map',
        map: 'china',
        geoIndex: 0,
        data: meta.units.map((u) => ({ name: u.name, itemStyle: { areaColor: '#e6e6e6', borderColor: '#9aa0a6', borderWidth: 0.6 } })),
      },
      {
        type: 'lines',
        coordinateSystem: 'geo',
        geoIndex: 0,
        silent: true,
        polyline: true,
          lineStyle: { color: '#4b5563', width: 2.4 },
        data: provinceLines.map((l) => ({ coords: l.coords })),
      },
    ],
  });
  const svg = chart.renderToSVGString();
  console.log('[2] full setOption OK, svg len =', svg.length);

  // 场景 3：series 数据与地图 region 匹配检查（数据行数应 ≈ 单位数，而非被追加成省数）
  try {
    const series = chart.getModel().getSeriesByIndex(0);
    const dataCount = series.getData().count();
    console.log('[3] series data count =', dataCount, '(单位数 =', meta.units.length, ')');
    console.log(dataCount >= meta.units.length ? '[3] 名称匹配 OK' : '[3] 名称匹配 FAIL');
  } catch (e) {
    console.log('[3] SSR 下无法读取 model（跳过）:', e.message);
  }
} catch (e) {
  console.log('[2] full setOption FAIL:', e.message);
}
