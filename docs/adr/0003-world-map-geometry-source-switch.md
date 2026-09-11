# 世界地图边界源从 Surbowl 换为 Natural Earth 50m，并以 TopoJSON 入库

世界地图原用 `@surbowl/world-geo-json-zh`（经 `scripts/fetch-world-data.mjs` 产出 `public/data/world.geojson`），其几何过于简陋：全图 239 面仅 11,693 个顶点，相邻顶点中位距离 0.733°、p90 1.909°；在 1000px 宽的世界图上即中位线段约 2.0px、p90 约 5.3px 一条，海岸线明显呈折线多边形。现将几何源换为 Natural Earth 50m admin_0 countries（公有领域），经 mapshaper `dp 50% keep-shapes` 简化后以 **TopoJSON** 入库为 `public/data/world_v2.topojson`：中位线段降到 0.179°（1000px 下 0.50px），p90 0.496°，精细度提升 4.1 倍，文件 430KB（旧档 298KB）。

**Status**: accepted

**Considered Options**：① **换 Natural Earth 110m**——实测仅 10,654 顶点、中位 0.709°，比现用源更粗，且面数从 239 掉到 177，是负收益的横向替换；② **Natural Earth 10m**——几何更细（dp6 时中位 0.276°、371KB），但装饰面从 44 个涨到 60 个，多出的 16 个争议飞地（拜科努尔、克利珀顿岛、珊瑚海群岛、比尔泰维勒、斯卡伯勒浅礁、关塔那摩湾、塞浦路斯缓冲区等）每一个都需要单独决定归类，而收益只在高倍缩放下可见——世界粒度不存在高倍缩放场景（国家为最小单元、无下钻）；③ **geoBoundaries gbOpen**——实测 17,400,000 顶点、中位 0.0002°（约细 3,700 倍），即便简化到 0.05% 仍有 5,577KB，且缺 ESH/SOL/CYN、混用 15 种许可证（以 ODbL 为主）带来 share-alike 摩擦；④ **GADM 4.1**——几何优秀但**完全不带 ISO 码**，且为非商业许可，不可入库公有仓库；⑤ **存 GeoJSON 而非 TopoJSON**——同一份 dp50 几何存 GeoJSON 为 1,645KB，存 TopoJSON 仅 430KB（3.8 倍差），因为相邻国共享的边界弧只存一次且坐标被量化成整数。最终选择 50m + TopoJSON。

**Consequences**：

- **答题语义零变化**：`countries.json` 一行未改，195 国的 `iso_a3`／中文名／全称／`center`／`neighbors`／`continent` 全部沿用旧档，因此答题池、熟练度分区、`__continent_*` 排行榜哨兵与用户既有进度均不受影响。输出面的 properties 契约与旧档逐字一致（`{ iso_a3, name, full_name, decorative }`）。
- **iso 取值必须用 `ISO_A3`（为 `-99` 时回退 `ADM0_A3`）**：源数据里 `ISO_A3` 对 8 个面是字面字符串 `-99`（含挪威、法国）。单独用 `ADM0_A3` 会漏 SSD/PSE（NE 标为 SDS/PSX，193/195）；用 `ISO_A3_EH` 会把它国的码借给属地（澳属印度洋领地与阿什莫尔和卡捷群岛都拿到 `AUS`，造成三面同名），而 ECharts 按 `properties.name` 建 region，同名会被**静默合并**成一个 region，导致着色与点击出错。
- **装饰面判定改为白名单**：旧管线列 44 个装饰 iso 的黑名单，失效模式是「多出一个答题国」并静默污染排行榜与熟练度；新管线反转为「只有对得上 `countries.json` 的 195 个 iso 才是答题国」，失效模式变成「少一个国家」，一眼可见。实测装饰面仍为 44 个（NE 另有 KOS/SOL/CYN/KAS 等争议面，旧档以 `-99` 承载；旧档的 UMI/CXR 在 50m 档不单独提供，二者本就只是灰色填充）。
- **中国保持单一合并面**：旧源政治上预合并（全图不存在名为台湾/香港/澳门的 feature，中国是一个 23 面 MultiPolygon），NE 则默认把 TWN/HKG/MAC 作为独立面输出。管线据**显式清单**把三者并回中国面，而非「按 bbox 封套吞并」——后者会把锡亚琴冰川（KAS，`-99` 的非答题争议面）一并吞进中国，把一块争议领土静默并进答题国面。同时输出文件的中文名**一律从 `countries.json` 反查**、永不采用新源名字，从结构上杜绝 NE 给台湾的 `NAME_ZH`（「中华民国」）流入界面。
- **南海诸岛需显式回补**：NE 50m 的中国面最南仅到北纬 18.2°（海南岛），南海岛礁整个不存在（10m 把南沙放在独立的 PGA 面里、110m 完全不画），而旧档中国面南伸至 3.4°，含曾母暗沙/南沙/西沙/中沙。管线从旧档移植这 15 个多边形（共 113 顶点、约 +1KB），并加了一条守恒断言（中国面最南纬度必须低于 18.3°），防止该主权相关回归静默复现。
- **标签锚点自动重算**：`renderer.ts` 用 `bestLabelAnchor(polygons)` 从几何现算国名标签锚点，故换源后锚点会变。实测 195/195 仍落在本国面上（`bestLabelAnchor` 以「离边界最远」为评分，天然向内收敛），漂移中位 0.053°（1000px 下 0.1px）、最大 1.959°（5.4px）。`countries.json` 的 `center` 不重生，仅用于镜头跟随与 BFS 距离排序，精度要求低。
- **旧档与旧管线保留为回滚路径**：`world.geojson` 与 `scripts/fetch-world-data.mjs` 一行不改留在库中（仍是版本库跟踪文件、仍可 URL 访问），仅 `src/data.ts` 停止加载；回滚只需把 fetch 目标换回 `world.geojson`，无需联网重下已可能失效的外网 CDN。`src/data.ts` 的 `AppData.worldGeoJson` 字段名保持不变（值改为由 TopoJSON 展开，与地级/省级各档同一读法，复用已有的 `topojson-client` 依赖）。
