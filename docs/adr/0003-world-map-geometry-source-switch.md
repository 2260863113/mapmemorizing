# 世界地图改用 Natural Earth 10m `_chn` 中国视角变体，并以 TopoJSON 入库；世界图改用 Robinson 投影

世界地图原用 `@surbowl/world-geo-json-zh`（经 `scripts/fetch-world-data.mjs` 产出 `public/data/world.geojson`），其几何过于简陋：全图 239 面仅 11,693 个顶点，相邻顶点中位距离 0.733°、p90 1.909°；在 1000px 宽的世界图上即中位线段约 2.0px、p90 约 5.3px 一条，海岸线明显呈折线多边形。现将几何源换为 **Natural Earth 10m admin_0 countries 的 `_chn`（中国视角）变体**（公有领域），经 mapshaper `dp 12% keep-shapes` 简化后以 **TopoJSON** 入库为 `public/data/world_v2.topojson`：中位线段 0.163°（1000px 下 0.45px）、p90 0.465°，精细度提升 4.5 倍，文件 636KB（旧档 298KB）。

同时把**世界图的投影**从等距圆柱改为 **Robinson 折中投影**（中国图不动）：等距圆柱不保面积，实测俄罗斯在图上面积是真实的 2.15 倍、格陵兰 3.82 倍，以致「俄罗斯看起来比非洲还大」（真实比值只有 0.574）；Robinson 收敛到 1.50 与 1.96 倍，俄/非比值回到 0.83。

**Status**: accepted

**Considered Options**：

**投影源**：① **换 Natural Earth 110m**——实测仅 10,654 顶点、中位 0.709°，比现用源更粗，且面数从 239 掉到 177，是负收益的横向替换；② **Natural Earth 50m 标准版**——曾被采纳，但实测**把藏南划给印度**（见下），且中国面最南仅到 18.2°N、南海岛礁整个不存在，需两处手工补丁；③ **Natural Earth 10m 标准版**——几何更细（dp6 时中位 0.276°），但装饰面从 44 涨到 60，且同样丢藏南；④ **geoBoundaries gbOpen**——实测 17,400,000 顶点、中位 0.0002°，即便简化到 0.05% 仍有 5,577KB，且缺 ESH/SOL/CYN、混用 15 种许可证（以 ODbL 为主）带来 share-alike 摩擦；⑤ **GADM 4.1**——几何优秀但**完全不带 ISO 码**，且为非商业许可，不可入库公有仓库；⑥ **存 GeoJSON 而非 TopoJSON**——同一份几何存 GeoJSON 为 8,899KB（简化前），存 TopoJSON 仅 636KB。最终选 **10m `_chn` 变体 + TopoJSON**。

**投影方式**：① **等距圆柱（保持现状）**——不解决高纬放大，「俄国过大」的问题依旧；② **Equal Earth / Gall-Peters 等面积**——面积严格保真，但高纬形状被横向拉宽得很明显，观感偏离常见世界图；③ **Robinson / Winkel Tripel 折中**——面积与形状取中间路线，是本次采纳项。Robinson 为 1961 年为 Rand McNally 设计、后被美国国家地理采用多年，视觉上接近大多数人对世界图的预期。

**Consequences**：

- **答题语义零变化**：`countries.json` 一行未改，195 国的 `iso_a3`／中文名／全称／`center`／`neighbors`／`continent` 全部沿用旧档，因此答题池、熟练度分区、`__continent_*` 排行榜哨兵与用户既有进度均不受影响。输出面的 properties 契约与旧档逐字一致（`{ iso_a3, name, full_name, decorative }`）。
- **必须用 `_chn` 变体，不能用标准版**：Natural Earth 标准版把**藏南（阿鲁纳恰尔）整块划给印度**。实测 8 个藏南真实城镇（达旺/邦迪拉/德让宗/瓦弄/墨脱/察隅/隆子/错那）：旧档 Surbowl 归中国 **8/8**、NE50 标准版 **4/8**、10m `_chn` 变体 **8/8**。NE 官方为中国用户提供 `_chn` 变体（字段 `ADM0_A3_CN`），已完成该边界处理；注意它**只有 10m 档**（`ne_50m_admin_0_countries_chn.geojson` 实测 404）。
- **藏南为什么不能「照南海诸岛那样从旧档移植」**：南海诸岛是与任何面都不重叠的**孤立小岛**，往中国面 push 多边形即可，纯增量、零副作用；而藏南位于中国面的**主体大环内部**（实测：旧档/NE50/`_chn` 三源中，藏南均落在同一主体环内，不是独立多边形），且当前属于印度面。移植必须同时 ①北移主体环的那条边界线（NE50 标准版此处有 101 个顶点）②从印度面减去同一区域——只做 ① 会与中国面重叠、只做 ② 会造成空洞，两者都做等于自己实现一遍多边形布尔运算。`_chn` 变体由 NE 官方完成上述手术，故本管线无需任何布尔运算，这是选它的核心理由。
- **南海诸岛仍需小幅回补**：`_chn` 变体把中国面最南推到 9.68°N，自带约 20 个南海岛礁多边形（含西沙、部分南沙），但**仍缺最南端**（曾母暗沙约 3.4°N、琼台礁约 7.0°N 不在其内）。管线从旧档移植**最南纬度低于 9.6°** 的多边形补上（实测 5 个多边形、36 顶点）。
- **领土断言取代「数量守恒」断言**：上一版只断言「195 答题国 / 44 装饰面」，结果藏南丢失在断言全绿的情况下静默发生 —— 守恒的是**数量**，不是**领土口径**。现改为语义断言：① 藏南 8 个真实城镇必须全部落在中国面内；② 中国面最南纬度必须低于 5°N（含曾母暗沙）。装饰面**数量**不再硬断言（旧档 44、`_chn` 变体 49，数量本身不是契约），改为断言「装饰面不得持有答题池内的 iso」。
- **装饰面数量从 44 变为 49**：`_chn` 变体多出 Dhekelia/Akrotiri/Bir Tawil/Clipperton/Scarborough Reef/Gibraltar 等争议面，且不再提供 KAS/PGA/KOS/SOL/CYN。这些面在界面上只是灰色填充，不参与答题。
- **iso 取值必须用 `ISO_A3`（为 `-99` 时回退 `ADM0_A3`）**：实测该规则在 `_chn` 变体下仍是 195/195 全匹配、零重复。单独用 `ADM0_A3` 会漏 SSD/PSE；用 `ISO_A3_EH` 会把它国码借给属地（IOA 与 ATC 都拿到 `AUS`，造成同名），而 ECharts 按 `properties.name` 建 region，**同名会被静默合并**，导致着色与点击出错。
- **台湾已在 `_chn` 变体内完成合并**：该变体全图不存在 `ADM0_A3=TWN` 的 feature（实测 count=0），中国面已含台湾。管线保留 `MERGE_INTO_CHN = ['TWN','HKG','MAC']` 清单作幂等防御（本次实测只有 HKG/MAC 需要并入，缺 TWN 时只打印一行说明、不算失败）。中文名**一律从 `countries.json` 反查**，从结构上杜绝 NE 给台湾的 `NAME_ZH`（「中华民国」）流入界面。
- **世界图投影改为 Robinson，中国图不动**：中国图纬度跨度有限（3.4–53.6°N），等距圆柱形变轻微，换投影收益很小，而它那套「地级/省级各五档 + 视口裁剪 + 港澳放大框 + 下钻」的联动很密，风险远大于收益。
- **投影会改变 ECharts 的 `geo.center` 语义**：一旦提供 `geo.projection`，ECharts 的 `center` **从经纬度变为投影后坐标**（`node_modules/echarts/lib/action/roamHelper.js`：「Use projected coord as center because it's linear」），`getBoundingRect()` 亦然；而 `dataToPoint` 仍收经纬度。因此渲染器内部以**经纬度**作为相机的规范表示，只在 `toGeoCenter`/`fromGeoCenter` 这一对转换里出现投影，6 处 `setOption` 与 2 处回读（`georoam`、`currentGeoView`）全部经此转换。
- **`pointToData` 在启用投影后是坏的（ECharts 5.6 缺陷，已规避）**：`node_modules/echarts/lib/coord/geo/Geo.js` 的 `pointToData` 先调 `projection.unproject(point)` 再调 `this.pointToProjected(point)`，**顺序反了** —— 它把原始**像素**直接喂给了 `unproject`。实测往返 0/6 正确（纬度恒塌缩成常数 -1.395），改成正确顺序（先逆 roam 变换、再 unproject）后 6/6 精确还原。当前唯一调用点是 `cull.ts` 的 `viewportBox`，而世界图裁剪在 `cullToViewport()` 里被 early-return，故**目前是潜伏缺陷而非线上故障**；已在 `cull.ts` 中改为「`pointToProjected` + `projection.unproject`」组合并注明原因，将来真开世界图裁剪时不会踩。
- **`boundingCoords` 对世界图保留（它是「地图偏窄」的原因，但不是裁剪）**：已确认 ECharts 采样该框求投影包围盒时，「Left」边走的是**对角线**而非竖直线，非线性投影下算得偏窄（实测 4.2843 vs 真实 5.3325）。遍历全部 73,370 个顶点核对：各种配置下最西/最东/最南/最北顶点均落在画布内、左右留白对称，**不产生裁剪或错位**；它的实际代价是**横向比例**（世界图被画得比理想窄约 24%）。保留的理由是取景基准确定、可复核；若将来想要满宽地图，可对世界图去掉 `boundingCoords`（安全，因为世界族只有一个数据档、运行时几何永不变化），但**必须同时改用那时的矩形宽**，否则大洲取景会失准。
- **世界图默认中心的纬度由投影反算**：Robinson 下「南极到 83.6°N」关于赤道不对称（南半球多 6.4°），投影包围盒的纵向中点落在约 **-1.378°**，不是赤道。取 `[0, -3.2]`（等距圆柱时代的旧值）会让世界图上下偏移约 1.2% 画布高。该值由 `robinsonUnproject` 现算，随投影公式联动，不靠手抄常数。
- **大洲取景的 zoom 公式随之改写（且必须宽高双适配）**：原式 `360 / 经度跨度` 只在等距圆柱下成立。Robinson 下同一段经度的投影宽度随纬度收缩（X(φ)：赤道 1.0 → 60°N 0.80 → 80°N 0.62）。但改写时踩了两个坑，均已实测修正：
  1. **只按宽度反推 zoom 会把画面纵向撑爆** —— 南北跨度大的框受害最重（南美占画布高 228%、非洲 164%）。这是**改动前就存在的老问题**（旧公式同样只算宽度），本次一并修掉。现为宽高双适配，取两个约束里更严格的那个，实测六洲在 900×460 / 1400×700 / 1200×1000 / 1600×900 / 2560×1080 五种画布下**全部 0/6 溢出**（改前 2–3/6 溢出）。
  2. **像素换算的分母必须是 ECharts 实际使用的投影矩形宽，不是真实投影宽度** —— 两者实测相差 **1.2447 倍**（4.2843 vs 5.3325）。因为 ECharts 采样 `boundingCoords` 时把「Left」边走成对角线（见下条），它算出的矩形偏窄；而 `zoom` 的语义是「相对这个矩形」，故必须用它的值。`pixelsPerProjectedUnit()` 与 `fitZoomForLngLatBox()` 已单测覆盖（含「用错分母会偏大」的回归断言）。
- **`boundingCoords` 对世界图保留**：世界族只有一个数据档，故其动机不是「换档不位移」而是取景基准确定、可复核（将来几何再变，投影比例与居中位置不跟着变）。已发现 ECharts 采样该框取投影包围盒时，「Left」边走的是**对角线**而非竖直线，非线性投影下会算得偏窄（实测 4.284 vs 真实 5.333）；但遍历全部 73,370 个顶点核对，最西/最东/最南/最北顶点在各种配置下均落在画布内、左右留白对称，**该偏差不影响可见性**。
- **标签锚点自动重算**：`renderer.ts` 用 `bestLabelAnchor(polygons)` 从几何现算国名标签锚点，故换源后锚点会变。实测 195/195 仍落在本国面上（`bestLabelAnchor` 以「离边界最远」为评分，天然向内收敛）。`countries.json` 的 `center` 不重生，仅用于镜头跟随与 BFS 距离排序（二者都是经纬度对经纬度比较，与投影无关）。
- **首次加载增量**：`world_v2.topojson` 636KB（旧档 298KB，均为未压缩）；gzip 后 205KB vs 107KB。
- **旧档与旧管线保留为回滚路径**：`world.geojson` 与 `scripts/fetch-world-data.mjs` 一行不改留在库中（仍是版本库跟踪文件、仍可 URL 访问），仅 `src/data.ts` 停止加载；回滚只需把 fetch 目标换回 `world.geojson`，无需联网重下已可能失效的外网 CDN。`src/data.ts` 的 `AppData.worldGeoJson` 字段名保持不变（值改为由 TopoJSON 展开，与地级/省级各档同一读法，复用已有的 `topojson-client` 依赖）。
- **验收证据是人工看图**：几何精细度与投影观感由 `scripts/shot-world-compare.mjs`（同投影对比两个源）与 `scripts/shot-world-projection.mjs`（对比两种投影）出图，人工比对；投影数学另有 `src/map/projection.test.ts` 的 23 条断言（官方系数表端点、往返一致性、面积失真必须小于等距圆柱）钉死。
