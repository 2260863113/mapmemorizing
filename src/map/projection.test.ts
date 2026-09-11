// Robinson 投影的数学契约测试。
//
// 为什么这些断言值得写：投影公式抄错一个系数，地图看起来「还是对的」——
// 只是比例悄悄错了，而面积失真正是引入该投影要解决的问题。所以这里钉死
// ①官方系数表的端点值 ②往返一致性 ③面积失真必须显著小于等距圆柱。
import { describe, expect, it } from 'vitest';
import {
  WORLD_BOUNDING_COORDS,
  WORLD_LAT_TOP,
  WORLD_PROJECTED_CENTER_LNGLAT,
  WORLD_PROJECTED_WIDTH,
  WORLD_PROJECTED_Y,
  fitZoomForLngLatBox,
  maxProjectedWidth,
  pixelsPerProjectedUnit,
  projectedWidth,
  robinsonProject,
  robinsonProjection,
  robinsonUnproject,
} from './projection';

describe('robinsonProject 官方系数表端点', () => {
  it('赤道半宽 = 0.8487 × π', () => {
    expect(robinsonProject([180, 0])[0]).toBeCloseTo(0.8487 * Math.PI, 9);
  });

  it('北极 y = 1.3523、南极 y = -1.3523', () => {
    expect(robinsonProject([0, 90])[1]).toBeCloseTo(1.3523, 9);
    expect(robinsonProject([0, -90])[1]).toBeCloseTo(-1.3523, 9);
  });

  it('极点经度收缩到赤道的 0.5322 倍（表中 90° 行的 X 系数）', () => {
    const ratio = robinsonProject([180, 90])[0] / robinsonProject([180, 0])[0];
    expect(ratio).toBeCloseTo(0.5322, 6);
  });

  it('45°N 经度收缩到 0.8962 倍（表中 45° 行的 X 系数）', () => {
    const ratio = robinsonProject([180, 45])[0] / robinsonProject([180, 0])[0];
    expect(ratio).toBeCloseTo(0.8962, 6);
  });

  it('x 关于本初子午线反对称，y 关于赤道反对称', () => {
    expect(robinsonProject([30, 40])[0] + robinsonProject([-30, 40])[0]).toBeCloseTo(0, 12);
    expect(robinsonProject([0, 30])[1] + robinsonProject([0, -30])[1]).toBeCloseTo(0, 12);
  });

  it('全球四角均为有限值（ECharts 会用它采样边界）', () => {
    for (const p of [[-180, -90], [180, -90], [-180, 90], [180, 90], [0, 83.6]]) {
      expect(robinsonProject(p).every(Number.isFinite)).toBe(true);
    }
  });
});

describe('robinsonUnproject 往返一致性', () => {
  it('常见地点往返还原（纬度容差 1e-3°）', () => {
    for (const p of [[0, 0], [116.4, 39.9], [-74, 40.7], [151.2, -33.9], [179, 70], [-179, -70], [0, 89]]) {
      const back = robinsonUnproject(robinsonProject(p));
      expect(back[0]).toBeCloseTo(p[0], 6);
      expect(back[1]).toBeCloseTo(p[1], 3);
    }
  });

  it('极值纬度不产生 NaN', () => {
    for (const p of [[0, 90], [0, -90], [0, 89.999], [180, -89.999]]) {
      expect(robinsonUnproject(robinsonProject(p)).every(Number.isFinite)).toBe(true);
    }
  });
});

describe('面积失真小于等距圆柱（引入该投影的目的）', () => {
  /** 同纬度 1°×1° 格的投影面积 / 球面面积，再以赤道为 1 归一化。 */
  const distortion = (lat: number) => {
    const d = 1e-4;
    const w = Math.abs(robinsonProject([1, lat])[0] - robinsonProject([0, lat])[0]);
    const h = Math.abs(robinsonProject([0, lat + d])[1] - robinsonProject([0, lat])[1]) / d;
    const rad = Math.PI / 180;
    const sphere = rad * rad * Math.cos(lat * rad);
    return (w * h) / sphere;
  };
  const norm = (lat: number) => distortion(lat) / distortion(0);

  it('赤道处归一化为 1', () => {
    expect(norm(0)).toBeCloseTo(1, 9);
  });

  it('60°N 放大倍数远小于等距圆柱的 2.00', () => {
    expect(norm(60)).toBeLessThan(1.6);
    expect(norm(60)).toBeGreaterThan(1.2); // 但 Robinson 并非严格等面积，仍大于 1
  });

  it('80°N 放大倍数远小于等距圆柱的 5.76', () => {
    expect(norm(80)).toBeLessThan(2.5);
  });

  it('失真随纬度单调不减', () => {
    const lats = [0, 15, 30, 45, 60, 75, 85];
    for (let i = 1; i < lats.length; i++) expect(norm(lats[i])).toBeGreaterThan(norm(lats[i - 1]));
  });
});

describe('世界图派生常数', () => {
  it('投影宽度 = 2 × 赤道半宽', () => {
    expect(WORLD_PROJECTED_WIDTH).toBeCloseTo(2 * robinsonProject([180, 0])[0], 9);
  });

  it('纬度上界 83.6°N 的投影 y 尚未到北极', () => {
    expect(WORLD_PROJECTED_Y[1]).toBeLessThan(robinsonProject([0, 90])[1]);
    expect(WORLD_PROJECTED_Y[1]).toBeGreaterThan(1.3);
  });

  it('默认中心经度居中、纬度偏南（南半球多出 6.4°）', () => {
    expect(WORLD_PROJECTED_CENTER_LNGLAT[0]).toBe(0);
    expect(WORLD_PROJECTED_CENTER_LNGLAT[1]).toBeLessThan(0);
    expect(WORLD_PROJECTED_CENTER_LNGLAT[1]).toBeGreaterThan(-4);
  });

  it('默认中心投影后恰好落在投影包围盒的纵向中点', () => {
    const y = robinsonProject([0, WORLD_PROJECTED_CENTER_LNGLAT[1]])[1];
    expect(y).toBeCloseTo((WORLD_PROJECTED_Y[0] + WORLD_PROJECTED_Y[1]) / 2, 9);
  });

  it('boundingCoords 覆盖全球经度与南极到 83.6°N', () => {
    expect(WORLD_BOUNDING_COORDS[0]).toEqual([-180, -90]);
    expect(WORLD_BOUNDING_COORDS[1]).toEqual([180, WORLD_LAT_TOP]);
  });
});

describe('projectedWidth / maxProjectedWidth', () => {
  it('同一经度跨度在高纬的投影宽度更小', () => {
    expect(projectedWidth(0, 10, 80)).toBeLessThan(projectedWidth(0, 10, 0));
  });

  it('maxProjectedWidth 取到框内该经度跨度的最大宽度', () => {
    // 欧洲框：最宽出现在纬度最低处（34°N）
    const w = maxProjectedWidth(-25, 60, 34, 71);
    expect(w).toBeGreaterThanOrEqual(projectedWidth(-25, 60, 34) - 1e-9);
    expect(w).toBeGreaterThanOrEqual(projectedWidth(-25, 60, 71) - 1e-9);
  });

  it('宽度随经度跨度单调不减', () => {
    expect(maxProjectedWidth(-25, 60, 34, 71)).toBeGreaterThan(maxProjectedWidth(-25, 30, 34, 71));
  });
});

describe('ECharts geo.projection 契约', () => {
  it('暴露 project 与 unproject 两个函数', () => {
    expect(typeof robinsonProjection.project).toBe('function');
    expect(typeof robinsonProjection.unproject).toBe('function');
  });

  it('project 返回二元数值数组（ECharts 按 [x, y] 取值）', () => {
    const p = robinsonProjection.project([123, 45]);
    expect(Array.isArray(p)).toBe(true);
    expect(p).toHaveLength(2);
    expect(p.every(Number.isFinite)).toBe(true);
  });

  it('unproject 接受二元数值数组并还原经纬度', () => {
    const p = robinsonProjection.project([123, 45]);
    const back = robinsonProjection.unproject(p);
    expect(back[0]).toBeCloseTo(123, 6);
    expect(back[1]).toBeCloseTo(45, 3);
  });
});

describe('pixelsPerProjectedUnit', () => {
  it('取宽高两个约束里更严格的那个', () => {
    // rect 宽高比 1.6116：画布 1400×700（比 2.0）比 rect 更宽 → 受高度约束
    expect(pixelsPerProjectedUnit(4.2843, 2.6584, 1400, 700)).toBeCloseTo(700 / 2.6584, 9);
    // 画布 1200×1000（比 1.2）比 rect 更窄 → 受宽度约束
    expect(pixelsPerProjectedUnit(4.2843, 2.6584, 1200, 1000)).toBeCloseTo(1200 / 4.2843, 9);
  });

  it('退化输入返回 0（调用方据此回退默认取景）', () => {
    expect(pixelsPerProjectedUnit(0, 2, 100, 100)).toBe(0);
    expect(pixelsPerProjectedUnit(4, 0, 100, 100)).toBe(0);
    expect(pixelsPerProjectedUnit(NaN, 2, 100, 100)).toBe(0);
  });
});

describe('fitZoomForLngLatBox（大洲取景）', () => {
  // 实测 ECharts 为世界图算出的矩形（比真实投影宽度 5.3325 窄，见 ADR-0003）
  const RECT_W = 4.2843;
  const RECT_H = 2.6584;
  const px = (w: number, h: number) => pixelsPerProjectedUnit(RECT_W, RECT_H, w, h);

  /** 复刻断言：把框四角投影后按 zoom 缩放，看是否落在画布内。 */
  const fitsIn = (box: [number, number, number, number], W: number, H: number) => {
    const [x0, y0, x1, y1] = box;
    const zoom = fitZoomForLngLatBox(x0, y0, x1, y1, px(W, H), W, H, 0.12);
    const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map((p) => robinsonProject(p));
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const spanX = (Math.max(...xs) - Math.min(...xs)) * px(W, H) * zoom;
    const spanY = (Math.max(...ys) - Math.min(...ys)) * px(W, H) * zoom;
    return { fitW: spanX <= W + 1e-6, fitH: spanY <= H + 1e-6, pctW: spanX / W, pctH: spanY / H };
  };

  // 六个大洲的标定框（与 renderer.CONTINENT_VIEWS 同值）
  const BOXES: Record<string, [number, number, number, number]> = {
    AS: [26, -11, 147, 56],
    EU: [-25, 34, 60, 71],
    AF: [-20, -36, 52, 38],
    NA: [-168, 6, -52, 74],
    SA: [-82, -56, -34, 13],
    OC: [112, -48, 180, 2],
  };

  it('六个大洲在多种画布尺寸下都能完整装进画面', () => {
    for (const [W, H] of [[900, 460], [1400, 700], [1200, 1000], [1600, 900], [2560, 1080]]) {
      for (const [name, box] of Object.entries(BOXES)) {
        const r = fitsIn(box, W, H);
        expect(r.fitW, `${name} 在 ${W}×${H} 横向溢出`).toBe(true);
        expect(r.fitH, `${name} 在 ${W}×${H} 纵向溢出`).toBe(true);
      }
    }
  });

  it('留白生效：至少有一边占到 80% 以上（不会缩得过小）', () => {
    for (const [W, H] of [[900, 460], [1400, 700]]) {
      for (const [name, box] of Object.entries(BOXES)) {
        const r = fitsIn(box, W, H);
        expect(Math.max(r.pctW, r.pctH), `${name} 在 ${W}×${H} 上缩得过小`).toBeGreaterThan(0.8);
      }
    }
  });

  it('padding 越大 zoom 越小（单调）', () => {
    const box: [number, number, number, number] = [-82, -56, -34, 13];
    const lo = fitZoomForLngLatBox(box[0], box[1], box[2], box[3], px(1400, 700), 1400, 700, 0.05);
    const hi = fitZoomForLngLatBox(box[0], box[1], box[2], box[3], px(1400, 700), 1400, 700, 0.3);
    expect(hi).toBeLessThan(lo);
  });

  it('退化输入返回 1（不产生 NaN/Infinity）', () => {
    expect(fitZoomForLngLatBox(0, 0, 1, 1, 0, 100, 100)).toBe(1);
    expect(fitZoomForLngLatBox(0, 0, 1, 1, 10, 0, 100)).toBe(1);
    expect(fitZoomForLngLatBox(0, 0, 1, 1, 10, 100, 100)).toBeGreaterThan(0);
  });

  it('赤道附近该用的分母是 ECharts 的矩形宽，不是真实投影宽度', () => {
    // 若误用真实投影宽度（5.3325）反推，zoom 会偏大 —— 这里钉死正确量级
    const box: [number, number, number, number] = [-20, -36, 52, 38]; // 非洲
    const zoom = fitZoomForLngLatBox(box[0], box[1], box[2], box[3], px(1400, 700), 1400, 700, 0.12);
    const wrongZoom = (WORLD_PROJECTED_WIDTH / maxProjectedWidth(box[0], box[2], box[1], box[3])) * 0.88;
    expect(wrongZoom / zoom).toBeGreaterThan(1.5); // 旧算法显著偏大（实测约 2.3 倍）
  });
});
