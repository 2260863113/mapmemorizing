/**
 * 「孤悬 / 极小」单位：**困难档放宽吸附容差**的对象（用户口径 2026-09-16）。
 *
 * 背景：困难档刻意不给任何吸附预告（不许靠提示"撞运气"），但有两类单位因此变得**格外**难：
 *   · **极小**：澳门在 1x 下只有约 0.5×1.2 像素、香港约 5×4.7——看不清边界，也就无从判断"快到了"；
 *   · **孤悬**：海南、台湾与大陆隔海（各自以广东/福建为兜底邻居），世界档的日本/澳大利亚/新西兰等
 *     19 个岛国同理——没有相邻的陆块做参照。
 * 对这两类，困难档的 5px 太苛刻，故按用户口径放宽到 15px；**只放宽判定范围，不放宽提示**
 * （困难档仍然一个绿边都不亮）。
 *
 * 认定规则（用户口径）= 三者取并集：
 *   1. **面积极小**（阈值见 `TINY_AREA_DEG2`）；
 *   2. **孤悬**（在本范围里没有陆地邻居——由 `buildPuzzleGraph` 的 `landConnected` 给出）；
 *   3. **另算岛国名单**（`EXTRA_ISLAND_UNITS`）。
 *
 * 为什么还需要第 3 条：第 2 条判据来自数据的 `neighbors` 字段，而**英国/爱尔兰互为陆地邻国、
 * 印尼与东帝汶/巴新/马来西亚相邻**，于是它们在世界档里"有陆地邻居"，会漏掉——但它们显然是岛国。
 * 名单是用户点名的 8 个；这是全项目唯一一处"按国名硬编码"的玩法口径，改动时请一并改文档。
 */
import type { PuzzlePieceDef } from './pieces';

/**
 * 「极小」的面积阈值，单位 **度²**（与碎片 `area` 同单位）。
 *
 * 用户口径是 2000 km²；碎片面积是地图数据里的 shoelace 面积（度²，不按纬度加权），
 * 按赤道换算 1 度² ≈ 12 395 km²，故 2000 km² ≈ 0.1614 度²。
 *
 * 两档的实际效果（都有真实数据测试钉住）：
 *   · **省级全国**：澳门 0.0025、香港 0.0911 入选；上海 0.7758、天津 1.2458 不入选
 *     （差 4.8 倍以上，纬度换算带来的偏差不会改变结论）。
 *   · **世界全国**：这条判据只为**有陆地邻居**的微型国补位——摩纳哥、圣马力诺、列支敦士登、安道尔。
 *     其余面积很小的国家（瑙鲁、图瓦卢、马尔代夫、马绍尔、毛里求斯…）本来就是"零陆地邻居"，
 *     已经由孤悬那条判据收进来了，与面积无关（毛里求斯 0.1649 就在阈值之外，照样入选）。
 */
export const TINY_AREA_DEG2 = 0.1614;

/** 困难档：孤悬/极小单位**尚未成组**时用的放宽容差（px，真值比例）。 */
export const SNAP_RELAXED_PX = 15;

/**
 * 「另算岛国」：本身是岛、但数据里给了陆地邻国，所以"零陆地邻居"这条判据捞不到它们。
 * 用户点名的 8 个：英国、爱尔兰、印尼、多米尼加、海地、巴布亚新几内亚、东帝汶、文莱。
 */
export const EXTRA_ISLAND_UNITS: readonly string[] = [
  'GBR', // 英国（与爱尔兰互为陆地邻国）
  'IRL', // 爱尔兰
  'IDN', // 印尼（与东帝汶/巴新/马来西亚相邻）
  'DOM', // 多米尼加（与海地同处伊斯帕尼奥拉岛）
  'HTI', // 海地
  'PNG', // 巴布亚新几内亚（与新几内亚岛另一半的印尼相邻）
  'TLS', // 东帝汶（与印尼相邻）
  'BRN', // 文莱（在加里曼丹岛上，与马来西亚相邻）
];

/** 面积是否属于「极小」。 */
export function isExtremelySmall(areaDeg2: number): boolean {
  return areaDeg2 <= TINY_AREA_DEG2;
}

/**
 * 某片是否属于「孤悬/极小」。
 *
 * @param landConnected 该片在**当前范围**里是否有陆地邻居（范围外的邻居不算——次区域档里
 *                      日本也是"孤悬"，这正是我们要的效果）
 */
export function isSpecialUnit(adcode: string, areaDeg2: number, landConnected: boolean): boolean {
  if (EXTRA_ISLAND_UNITS.includes(adcode)) return true;
  if (isExtremelySmall(areaDeg2)) return true;
  return !landConnected;
}

/** 本范围里所有「孤悬/极小」的片（困难档放宽 + 之后判定都要用）。 */
export function specialUnitsOf(pieces: PuzzlePieceDef[], landConnected: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const piece of pieces) {
    if (isSpecialUnit(piece.adcode, piece.area, landConnected.has(piece.adcode))) out.add(piece.adcode);
  }
  return out;
}

/**
 * 本范围里「极小」的片（**只按面积**，海岛不算）——卡槽供应顺序里排到最后的那批。
 *
 * 与 `specialUnitsOf` 是**两个不同的集合**，别合并：放宽吸附要照顾"看得清但隔海"的大岛
 * （台湾、澳大利亚），而"排到最后"是为了防止**从卡槽拿出来就找不到了**，只对真的看不清的片有意义。
 */
export function tinyUnitsOf(pieces: PuzzlePieceDef[]): Set<string> {
  const out = new Set<string>();
  for (const piece of pieces) {
    if (isExtremelySmall(piece.area)) out.add(piece.adcode);
  }
  return out;
}
