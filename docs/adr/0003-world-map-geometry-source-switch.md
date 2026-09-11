# 世界地图几何源改用 Natural Earth 10m `_chn` 中国视角变体，并以 TopoJSON 入库

世界地图最初用 `@surbowl/world-geo-json-zh`（经 `scripts/fetch-world-data.mjs` 产出 `public/data/world.geojson`），其几何过于简陋：全图 239 面仅 11,693 个顶点，相邻顶点中位距离 0.733°、p90 1.909°；在 1000px 宽的世界图上即中位线段约 2.0px、p90 约 5.3px 一条，海岸线明显呈折线多边形。中途曾换为 Natural Earth 50m 标准版，但实测该版本**把藏南划给印度**，故再次换源为 **Natural Earth 10m admin_0 countries 的 `_chn`（中国视角）变体**（公有领域），经 mapshaper `dp 12% keep-shapes` 简化后以 **TopoJSON** 入库为 `public/data/world_v2.topojson`：中位线段 0.163°（1000px 下 0.45px）、p90 0.465°，比最初的旧档精细 4.5 倍，文件 636KB（旧档 298KB）。

**Status**: accepted

**Considered Options**：① **换 Natural Earth 110m**——实测仅 10,654 顶点、中位 0.709°，比现用源更粗，且面数从 239 掉到 177，是负收益的横向替换；② **Natural Earth 50m 标准版**——曾被采纳，但实测把藏南划给印度（见下），且中国面最南仅到 18.2°N、南海岛礁整个不存在，需两处手工补丁；③ **Natural Earth 10m 标准版**——几何更细（dp6 时中位 0.276°），但装饰面从 44 涨到 60，且同样丢藏南；④ **Natural Earth 10m `_chn` 中国视角变体**——几何最细，且官方已完成藏南边界处理，**本次采纳**（注意它只有 10m 档，`ne_50m_admin_0_countries_chn.geojson` 实测 404）；⑤ **geoBoundaries gbOpen**——实测 17,400,000 顶点、中位 0.0002°，即便简化到 0.05% 仍有 5,577KB，且缺 ESH/SOL/CYN、混用 15 种许可证（以 ODbL 为主）带来 share-alike 摩擦；⑥ **GADM 4.1**——几何优秀但**完全不带 ISO 码**，且为非商业许可，不可入库公有仓库；⑦ **存 GeoJSON 而非 TopoJSON**——同一份几何存 GeoJSON 为 8,899KB（简化前），存 TopoJSON 仅 636KB。

**Consequences**：

- **答题语义零变化**：`countries.json` 一行未改，195 国的 `iso_a3`／中文名／全称／`center`／`neighbors`／`continent` 全部沿用旧档，因此答题池、熟练度分区、`__continent_*` 排行榜哨兵与用户既有进度均不受影响。输出面的 properties 契约与旧档逐字一致（`{ iso_a3, name, full_name, decorative }`）。
- **必须用 `_chn` 变体，不能用标准版（本轮换源的核心理由）**：Natural Earth 标准版把**藏南整块划给印度**。实测 8 个藏南真实城镇（达旺/邦迪拉/德让宗/瓦弄/墨脱/察隅/隆子/错那）：旧档 Surbowl 归中国 **8/8**、NE50 标准版 **4/8**（达旺/邦迪拉/德让宗/瓦弄 翻给印度）、10m `_chn` 变体 **8/8**。98 格点探针同样一致：旧档 59 中国/21 印度、NE50 标准 **36/45**、`_chn` **60/21**。NE 官方为中国用户提供 `_chn` 变体（字段 `ADM0_A3_CN`），已完成该边界处理。
- **藏南为什么不能「照南海诸岛那样从旧档移植」**：南海诸岛是与任何面都不重叠的**孤立小岛**，往中国面 push 多边形即可，纯增量、零副作用；而藏南位于中国面的**主体大环内部**（实测：旧档/NE50/`_chn` 三源中藏南均落在同一主体环内，**不是独立多边形**），且当前属于印度面。移植必须同时 ①北移主体环的那条边界线（NE50 标准版此处有 101 个顶点）②从印度面减去同一区域——只做 ① 会与中国面重叠、只做 ② 会造成空洞，两者都做等于自己实现一遍多边形布尔运算。此外旧档藏南边界精细度也不够（框内仅 16 顶点、线段中位 0.461°，新档全图中位 0.163°），移植后接缝会有锯齿。`_chn` 变体由 NE 官方完成上述手术，故本管线无需任何布尔运算，这是选它的核心理由。
- **南海诸岛仍需小幅回补**：`_chn` 变体把中国面最南推到 9.68°N，自带约 20 个南海岛礁多边形（含西沙、部分南沙），但**仍缺最南端**（曾母暗沙约 3.4°N、琼台礁约 7.0°N 不在其内）。管线从旧档移植**最南纬度低于 9.6°** 的多边形补上（实测 5 个多边形、36 顶点），补后中国面最南 3.40°N。
- **领土断言取代「数量守恒」断言**：上一版只断言「195 答题国 / 44 装饰面」，结果藏南丢失在**断言全绿**的情况下静默发生 —— 守恒的是**数量**，不是**领土口径**。现改为语义断言：① 藏南 8 个真实城镇必须全部落在中国面内（射线法，与渲染器同一套数学）；② 中国面最南纬度必须低于 5°N（含曾母暗沙）。装饰面**数量**不再硬断言（旧档 44、`_chn` 变体 49，数量本身不是契约），改为断言「装饰面不得持有答题池内的 iso」。
- **装饰面数量从 44 变为 49**：`_chn` 变体多出 Dhekelia/Akrotiri/Bir Tawil/Clipperton/Scarborough Reef/Gibraltar 等争议面，且不再提供 KAS/PGA/KOS/SOL/CYN。这些面在界面上只是灰色填充，不参与答题。
- **iso 取值必须用 `ISO_A3`（为 `-99` 时回退 `ADM0_A3`）**：实测该规则在 `_chn` 变体下仍是 195/195 全匹配、零重复。单独用 `ADM0_A3` 会漏 SSD/PSE；用 `ISO_A3_EH` 会把它国码借给属地（IOA 与 ATC 都拿到 `AUS`，造成同名），而 ECharts 按 `properties.name` 建 region，**同名会被静默合并**，导致着色与点击出错。
- **台湾已在 `_chn` 变体内完成合并**：该变体全图不存在 `ADM0_A3=TWN` 的 feature（实测 count=0），中国面已含台湾。管线保留 `MERGE_INTO_CHN = ['TWN','HKG','MAC']` 清单作幂等防御（本次实测只有 HKG/MAC 需要并入，缺 TWN 时只打印一行说明、不算失败）。中文名**一律从 `countries.json` 反查**，从结构上杜绝 NE 给台湾的 `NAME_ZH`（「中华民国」）流入界面。
- **中国保持单一合并面**：管线据**显式清单**并入 TWN/HKG/MAC，而非「按 bbox 封套吞并」—— 后者会把锡亚琴冰川（KAS）一类争议面一并吞进中国，把争议领土静默并进答题国面。
- **标签锚点自动重算**：`renderer.ts` 用 `bestLabelAnchor(polygons)` 从几何现算国名标签锚点，故换源后锚点会变。实测 195/195 仍落在本国面上（`bestLabelAnchor` 以「离边界最远」为评分，天然向内收敛）。`countries.json` 的 `center` 不重生，仅用于镜头跟随与 BFS 距离排序（都是经纬度对经纬度比较）。
- **首次加载增量**：`world_v2.topojson` 636KB（旧档 298KB，均为未压缩）；gzip 后 205KB vs 107KB。
- **旧档与旧管线保留为回滚路径**：`world.geojson` 与 `scripts/fetch-world-data.mjs` 一行不改留在库中（仍是版本库跟踪文件、仍可 URL 访问），仅 `src/data.ts` 停止加载；回滚只需把 `src/data.ts` 的目标换回 `world.geojson`，无需联网重下已可能失效的外网 CDN。`src/data.ts` 的 `AppData.worldGeoJson` 字段名保持不变（值改为由 TopoJSON 展开，与地级/省级各档同一读法，复用已有的 `topojson-client` 依赖）。
- **验收证据是人工看图**：几何精细度由 `scripts/shot-world-compare.mjs` 出图（同投影对比新旧两个源，5 组，每组上=旧档、下=新档），人工比对；藏南等领土口径另由管线内置的语义断言守护。

**关于世界图投影（曾实施后回滚，记录以免重复尝试）**：曾把世界图投影从等距圆柱改为 Robinson 折中投影（等距圆柱不保面积，实测俄罗斯在图上面积是真实的 2.15 倍、格陵兰 3.82 倍，以致「俄罗斯看起来比非洲还大」，真实比值只有 0.574；Robinson 收敛到 1.50/1.96 倍，俄非比值回到 0.828）。该改动**已按用户要求整体回滚**，世界图恢复等距圆柱。若将来重启此方向，以下是当时实测到的关键事实：
- 提供 `geo.projection` 后 ECharts 的 `geo.center` 语义**从经纬度变为投影后坐标**（`node_modules/echarts/lib/action/roamHelper.js`：「Use projected coord as center because it's linear」），`getBoundingRect()` 亦然，而 `dataToPoint` 仍收经纬度。需要让渲染器内部相机恒为经纬度，投影只出现在一对 `toGeoCenter`/`fromGeoCenter` 转换里。
- `pointToData` 在启用投影后是坏的（ECharts 5.6 缺陷）：`lib/coord/geo/Geo.js` 先 `projection.unproject(point)` 再 `this.pointToProjected(point)`，**顺序反了**（把原始像素喂给了 `unproject`），实测往返 0/6 正确；唯一调用点是 `cull.ts` 的 `viewportBox`（世界图裁剪被 early-return，故当时未触发）。
- ECharts 采样 `boundingCoords` 求投影包围盒时「Left」边走的是**对角线**而非竖直线，算出的矩形偏窄（4.2843 vs 真实 5.3325）；不产生裁剪，但会使地图横向偏窄。按 `zoom` 换算取景时**必须用这个实际矩形宽**，否则会系统性偏大 1.2447 倍。
- 大洲取景的 zoom **必须宽高双适配**：只按宽度反推会把南北跨度大的框纵向撑爆（南美占画布高 228%、非洲 164%）。**这是等距圆柱下就存在的老问题**，与投影无关，故回滚投影也一并保留了该结论供将来参考。
