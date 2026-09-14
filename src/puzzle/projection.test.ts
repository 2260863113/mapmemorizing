import { describe, it, expect } from 'vitest';
import {
  PUZZLE_ASPECT,
  PUZZLE_BBOX,
  PUZZLE_LAT_PER_LNG,
  PUZZLE_SPAN_LAT,
  PUZZLE_SPAN_LNG,
  project,
  projectBBox,
  projectX,
  projectY,
  pxBBoxOf,
  spanLat,
  spanLng,
  svgPathOf,
  unitScale,
  unproject,
} from './projection';

const SCALE = 27; // 默认比例下约 27px/°（1440 宽视口）
const CN = PUZZLE_BBOX.china;

describe('拼图投影', () => {
  it('bbox 左上角映射到原点，右下角映射到幅面尺寸', () => {
    expect(projectX(CN.minLng, SCALE)).toBeCloseTo(0, 9);
    expect(projectY(CN.maxLat, SCALE)).toBeCloseTo(0, 9);
    expect(projectX(CN.maxLng, SCALE)).toBeCloseTo(PUZZLE_SPAN_LNG * SCALE, 6);
    expect(projectY(CN.minLat, SCALE)).toBeCloseTo(PUZZLE_SPAN_LAT * SCALE * PUZZLE_LAT_PER_LNG, 6);
  });

  it('世界族用自己的一套 bbox（-180..180 / -90..83.6），与地图页一致', () => {
    expect(spanLng('world')).toBeCloseTo(360, 6);
    expect(spanLat('world')).toBeCloseTo(173.6, 6);
    expect(projectX(-180, SCALE, 'world')).toBeCloseTo(0, 6);
    expect(projectY(83.6, SCALE, 'world')).toBeCloseTo(0, 6);
    // 同一经度在两族下的 x 不同（族是显式参数，不会串味）
    expect(projectX(100, SCALE, 'world')).not.toBeCloseTo(projectX(100, SCALE, 'china'), 3);
    // 缺省族仍是中国（老调用点不用改）
    expect(projectX(100, SCALE)).toBeCloseTo(projectX(100, SCALE, 'china'), 9);
  });

  it('纬度是反向的（纬度越高 y 越小），且每度纬度比每度经度长 1/aspectScale 倍', () => {
    expect(projectY(40, SCALE)).toBeLessThan(projectY(30, SCALE));
    const perLat = Math.abs(projectY(40, SCALE) - projectY(39, SCALE));
    const perLng = projectX(101, SCALE) - projectX(100, SCALE);
    expect(perLat).toBeCloseTo(perLng / PUZZLE_ASPECT, 6);
    expect(perLat).toBeGreaterThan(perLng); // 纬度被"拉长"（经度被压短），与地图页一致
  });

  it('unproject 是 project 的逆', () => {
    for (const point of [[100, 30], [120.5, 45.25], [73.5, 53.6]] as [number, number][]) {
      const [x, y] = project(point, SCALE);
      const back = unproject(x, y, SCALE);
      expect(back[0]).toBeCloseTo(point[0], 6);
      expect(back[1]).toBeCloseTo(point[1], 6);
    }
  });

  it('projectBBox / pxBBoxOf 给出 px 幅面', () => {
    const box = projectBBox([100, 20, 110, 30], SCALE);
    expect(box[0]).toBeCloseTo(projectX(100, SCALE), 6);
    expect(box[1]).toBeCloseTo(projectY(30, SCALE), 6);
    expect(box[2]).toBeCloseTo(projectX(110, SCALE), 6);
    expect(box[3]).toBeCloseTo(projectY(20, SCALE), 6);

    const px = pxBBoxOf([[[[100, 20], [110, 20], [110, 30], [100, 30]]]], SCALE);
    expect(px[0]).toBeCloseTo(box[0], 6);
    expect(px[3]).toBeCloseTo(box[3], 6);
  });

  it('svgPathOf 生成闭合路径，多环时多段 M', () => {
    const one = svgPathOf([[[[100, 20], [110, 20], [110, 30]]]], SCALE);
    expect(one.match(/M/g)).toHaveLength(1);
    expect(one.match(/Z/g)).toHaveLength(1);
    expect(one).toMatch(/^M[\d.]+ [\d.]+L/);

    const two = svgPathOf(
      [
        [[[100, 20], [110, 20], [110, 30]]],
        [[[120, 20], [121, 20], [121, 21]]],
      ],
      SCALE,
    );
    expect(two.match(/M/g)).toHaveLength(2);

    expect(svgPathOf([], SCALE)).toBe('');
    expect(svgPathOf([[[[100, 20], [110, 20]]]], SCALE)).toBe(''); // 少于三个点不成面
  });
});

/**
 * 「拼图 1x = 地图 1x」的硬闸门（用户口径 2026-09）。
 *
 * 期望值不是推导出来的常数，而是**地图页实测**的每像素度数：1440×900 窗口下点击模式全国视图
 * 的 `viewportWindow().perPxX = 0.11230425055928414`（度/像素）⇒ 8.904 px/°。公式一旦漂移，
 * 拼图 1x 就会和地图 1x 不一样大，这里立刻失败。
 */
describe('unitScale（拼图 1x = 地图 1x）', () => {
  const MAP_CANVAS = { width: 1410, height: 745 };
  const MEASURED_DEG_PER_PX = 0.11230425055928414;

  it('中国族在 1410×745 画布上与地图实测一致（8.904 px/°）', () => {
    const scale = unitScale('china', MAP_CANVAS.width, MAP_CANVAS.height);
    expect(scale).toBeCloseTo(1 / MEASURED_DEG_PER_PX, 2);
    // 也等于「把 bbox 装进容器 80% 高度」的解析解
    expect(scale).toBeCloseTo((0.8 * MAP_CANVAS.height) / (spanLat('china') * PUZZLE_LAT_PER_LNG), 6);
  });

  it('世界族按同一规则（高度受限时 = 0.8H /（纬度跨度 × 1/0.75））', () => {
    const scale = unitScale('world', MAP_CANVAS.width, MAP_CANVAS.height);
    expect(scale).toBeCloseTo((0.8 * MAP_CANVAS.height) / (spanLat('world') * PUZZLE_LAT_PER_LNG), 6);
    expect(scale).toBeLessThan(unitScale('china', MAP_CANVAS.width, MAP_CANVAS.height));
  });

  it('又高又窄的容器改成宽度受限（两个方向取更紧的）', () => {
    const narrow = unitScale('china', 400, 2000);
    expect(narrow).toBeCloseTo((0.8 * 400) / spanLng('china'), 6);
    expect(narrow).toBeLessThan(unitScale('china', 1410, 2000));
  });
});
