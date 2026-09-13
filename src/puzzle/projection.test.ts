import { describe, it, expect } from 'vitest';
import {
  PUZZLE_ASPECT,
  PUZZLE_BBOX,
  PUZZLE_SPAN_LAT,
  PUZZLE_SPAN_LNG,
  project,
  projectBBox,
  projectX,
  projectY,
  pxBBoxOf,
  svgPathOf,
  unproject,
} from './projection';

const SCALE = 27; // 默认比例下约 27px/°（1440 宽视口）

describe('拼图投影', () => {
  it('bbox 左上角映射到原点，右下角映射到幅面尺寸', () => {
    expect(projectX(PUZZLE_BBOX.minLng, SCALE)).toBeCloseTo(0, 9);
    expect(projectY(PUZZLE_BBOX.maxLat, SCALE)).toBeCloseTo(0, 9);
    expect(projectX(PUZZLE_BBOX.maxLng, SCALE)).toBeCloseTo(PUZZLE_SPAN_LNG * SCALE, 6);
    expect(projectY(PUZZLE_BBOX.minLat, SCALE)).toBeCloseTo(PUZZLE_SPAN_LAT * SCALE * PUZZLE_ASPECT, 6);
  });

  it('纬度是反向的（纬度越高 y 越小），并带 ECharts 的 0.75 压缩比', () => {
    expect(projectY(40, SCALE)).toBeLessThan(projectY(30, SCALE));
    const oneDegree = Math.abs(projectY(40, SCALE) - projectY(39, SCALE));
    expect(oneDegree).toBeCloseTo(SCALE * PUZZLE_ASPECT, 6);
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
