# 中国行政区记忆助手 — 设计文档（定稿 v1）

> 帮助用户记忆中国行政区（精确到地级市）。输入地名（允许省略"自治州""土家族"等限定词，如输入"黔南"即可），地图上对应区域变色标记为已记忆。
> 状态：**设计定稿，待编码**。技术栈：Vite + TypeScript + ECharts（无框架）。

## 1. 已确认决策

| 决策点 | 结论 |
|---|---|
| 地图渲染 | **ECharts 纯矢量地图**（无底图瓦片，无坐标系偏移问题） |
| 记忆单位口径 | **直辖市/港澳/台湾整体各算 1 个单位**，共约 340 个单位 |
| MVP 范围 | 输入变色 + 记忆进度统计（测试模式、复习为二期扩展） |
| 技术栈 | Vite + TypeScript + ECharts，不引框架 |

> 注：因渲染选型为 ECharts，原方案中的 Leaflet 不再需要。

## 2. 记忆单位定义（约 340 个）

| 类别 | 数量 | 说明 |
|---|---|---|
| 地级行政区 | 333 | 293 地级市 + 7 地区 + 30 自治州 + 3 盟（数量由数据生成，不硬编码） |
| 直辖市整体 | 4 | 北京、上海、天津、重庆 各 1 个单位 |
| 特别行政区整体 | 2 | 香港、澳门 |
| 台湾省整体 | 1 | 台湾 |
| **合计** | **≈ 340** | 以实际数据文件为准 |

边界情况说明：
- 海南省直辖县级单位（琼海、五指山等）不计入（属县级，与"地级"口径一致排除）；三沙、儋州是地级市，计入 333。
- 新疆近年新设地级市（如白杨市）随数据文件自动纳入。

## 3. 总体架构

```
┌─ 输入层 ──┐   ┌─ 匹配引擎 ──┐   ┌─ 渲染层 ────┐   ┌─ 状态层 ────┐
│ 搜索框    │ → │ 规范化     │ → │ ECharts map │ ← │ localStorage │
│ 候选下拉  │   │ 模糊匹配   │   │ 变色/缩放   │   │ 记忆进度    │
└───────────┘   │ 消歧       │   └─────────────┘   └─────────────┘
                └────────────┘
```

- **adcode 是唯一主键**：名称匹配、地图着色、记忆状态全部通过 adcode 关联，三者解耦。
- 单向数据流：输入 → 匹配出 adcode → 渲染层着色 → 状态层记录。

## 4. 数据层

### 4.1 数据源（一次性下载，打包进项目，运行时零网络依赖）
- [cn-atlas](https://github.com/BarbarossaWang/cn-atlas)（`shengshixian.com` 2023 行政区划 shp → mapshaper 简化 → TopoJSON，共享弧拓扑，相邻边无缝隙）：
  - `prefectures` 372 面：**全部取用**，含地级市/自治州/地区/盟 + 省直辖县级市 + 新疆兵团城市 + 港澳台整体单位（属同一套弧拓扑，天然无缝隙）
  - `provinces` 34 面（省/自治区/直辖市/特别行政区/台湾）
- 南海诸岛装饰面（1 个）来自阿里 DataV —— cn-atlas 完全没有这一面，且它是一组远离大陆的岛礁散点，与任何陆地都不相邻，单独补入不会产生接缝。
- 换源原因（2026-09）：DataV 逐面数字化导致相邻边 32.7% 零共享 → 地图缝隙；cn-atlas 共享弧 0% 零共享。
- **单一来源原则**：除南海诸岛外全部面取自 `prefectures`，不再从 DataV 补县级面。跨源拼合过的那些面边界既不共享顶点也不完全重合（实测相邻 41 对中 40 对互相**重叠** 0.2%~27%），任何缝合法都会留下副作用（见 4.2）。

### 4.2 数据管线（scripts/fetch-cn-atlas.mjs，Node 脚本，一次性运行）
1. 下载 cn-atlas TopoJSON，用 topojson-client 展开 prefectures/provinces。
2. 对齐 `units.json` 口径：取**全部** 372 个 `prefectures` 面（`properties.id != null`），按 `区划码` 建 `NAME_BY_ADCODE` 映射取中文名，并补入 `units.json` 原先遗漏的两个兵团市（**新星市 659011**、**白杨市 659012**，见下），再单独补 1 个南海诸岛面。
3. 先 `-explode` 拆 MultiPolygon → 拓扑保持简化 → 最后按 adcode 合并回 MultiPolygon，出**四档简化 + 一档无损**（最精细档不经过 `-simplify`）：

   | 文件 | 档位 | 保留顶点 | 实际顶点 | 体积 | zoom 区间 |
   |---|---|---|---|---|---|
   | `china_units_ultra.json` | ultra | 4% | 11,464 | **124KB** | < 2 |
   | `china_units_pro.json` | pro | 8% | 18,173 | **158KB** | 2 ~ 6 |
   | `china_units.json` | fine | 15% | 29,828 | **215KB** | 6 ~ 10 |
   | `china_units_plus.json` | plus | 40% | 71,509 | **416KB** | 10 ~ 14 |
   | `china_units_lossless.json` | lossless | 100% | 173,337 | **908KB** | ≥ 14 或钻省 |
   | `china_units_coarse.json` | — | 8% | 18,173 | 158KB | 历史别名，内容 = pro |

   **为什么新增 pro 8% / plus 40%**：原三档的精细度落差极不均匀 —— ultra(4%)→fine(15%) 顶点差 2.6 倍，fine(15%)→lossless(100%) 差 5.8 倍。放大时能明显感到「fine 在 10~13 倍率偏糙、一过 14 倍又突然变精细」。补的比例取自相邻档的**几何中点**（√(4×15)≈7.7→8、√(15×100)≈38.7→40），把落差压到 1.9x / 2.0x / 2.4x，缩放观感更连续。
4. 省级同法四档 + 一档无损，**与地级同一套阈值与比例**：

   | 文件 | 档位 | 保留顶点 | 实际顶点 | 体积 | zoom 区间 |
   |---|---|---|---|---|---|
   | `china_provinces_ultra.json` | ultra | 4% | 4,875 | **43KB** | < 2 |
   | `china_provinces_pro.json` | pro | 8% | 7,524 | **58KB** | 2 ~ 6 |
   | `china_provinces.json` | fine | 15% | 12,086 | **84KB** | 6 ~ 10 |
   | `china_provinces_plus.json` | plus | 40% | 28,365 | **174KB** | 10 ~ 14 |
   | `china_provinces_raw.json` | lossless | 100% | 68,879 | **396KB** | ≥ 14 |

   **省级必须存 TopoJSON 而非 GeoJSON**：省级面与地级面一样拓扑相邻，共享弧压缩收益极大。实测同顶点数下 TopoJSON 比 GeoJSON 小 **78%~84%**；plus 档若存 GeoJSON 为 1087KB，**比 100% 顶点的无损档 TopoJSON（396KB）还大 2.7 倍**。改存 TopoJSON 后 plus 从 1087KB 降到 174KB。运行期由 `data.ts` 的 `provTopoToGeoJson()` 统一转回 GeoJSON，下游（renderer / inset）无需改动。

   **历史文件名兼容**：`china_provinces.geojson`（= fine 展开后的 GeoJSON，467KB）与 `china_provinces_coarse.geojson`（= ultra，192KB）仍照旧写出，只服务「浏览器缓存里还是旧 index.html + 旧 hash bundle」的用户；新 bundle 一律只读 TopoJSON 档。省级各档曾短暂以 GeoJSON 输出（`china_provinces_{ultra,pro,plus}.geojson`），管线会自动删除这些退役产物。
5. 用 fine 档几何重建 `units.json` 的 center/neighbors（372 个单位，含 32 个装饰面）。
6. **港澳放大框 `hkmac.geojson`**：从省级无压缩几何抽取 广东(440000)+香港(810000)+澳门(820000) 三面，始终不简化（125KB，同步加载）。
7. **缝隙闸门**：各档（含无损档，`coarse` 别名跳过）展开成 GeoJSON 后跑两道检查，任一不过即 `exit 1` 拒绝输出：
   - 邻接表检查：`units.json` 里互为邻居的单位必须共享 ≥1 顶点；
   - **源拓扑检查**：从源 TopoJSON 直接读出「共享 ≥1 条 arc」的 970 对真相邻，各档里必须仍全部共享 ≥1 顶点。
8. 退役产物清理：`china_decorative.geojson`（装饰面已并入拓扑）与 `china_provinces_{ultra,pro,plus}.geojson`（省级改存 TopoJSON 后作废）若存在则删除；`scripts/check-data.mjs` 也会把 `china_decorative.geojson` 当问题报出。

**为什么不做 `-snap` / `-clean` 缝合（2026-09 第二次修正，已推翻上一版结论）**

上一版从 DataV 补了 30 个县级面，与 cn-atlas 核心面是两个独立来源，因此引入 `-snap interval=0.01` + `-clean gap-width=auto` 缝合，把跨源相邻对的共享弧比例从 39% 提到 100%。缝合本身达到了目的，但**代价是 `-clean` 会在被缝合的面上开洞**：

| 方案 | 面数 | 内环总数 | 无人填的洞 | 无人填面积 | 地级视图露白（省−地真空） |
|---|---|---|---|---|---|
| ① 341 cn-atlas + 30 DataV → snap+clean（上一版，已提交） | 371 | 125 | **33** | **12592 km²** | 11928 km² |
| ② 全部 372 cn-atlas 原生，无 snap/clean（**现行**） | 373 | 46 | **0** | **0 km²** | 7270 km² |
| ③ 341 真实 + 32 源内县级 → snap+clean | 373 | 126 | 24 | 3984 km² | 8500 km² |

- `-clean` 的语义是「把两面的重叠区判给一方，并给对方留一个洞」。当两面来自不同来源、边界错开 0.2%~27% 时，它就必然造洞；造出的洞若没有第三个面去填，渲染出来就是**露白的坑**。实测把 341 个 cn-atlas 真面单独喂进去：原样 22 面/46 洞，只 snap 22/45，**snap+clean 变成 81 面/119 洞**，其中 12 个洞落在 9 个沿海单位（儋州/宁波/茂名/湛江/宁德/惠州/漳州/泉州/大连）—— 这就是用户看到的「省内缝隙」与新疆坑洞的共同成因。
- 改用单一来源后，`prefectures` 内的 46 个内环**全部**是 cn-atlas 自己留的、由同拓扑内的县级面填充的结构性内环，天然被邻居盖住，无需任何缝合。用户报告的 33 个坑洞（12,592 km²，**全部在新疆**）在方案 ② 下归零。
- 剩下 7270 km² 的「省级面覆盖、地级面不覆盖」区域经形状分析**全部是 3093 条细条**（平均厚度 1.0~2.3km，成团块 **0** 个），是 cn-atlas 的 `provinces` 与 `prefectures` 两个对象各自的海岸线数字化差异，分布在沿海各省（华南 2954 / 北方 2307 / 华东 1530 km²），不是缺陷；且被 2.4px 的省界线盖住，肉眼不可见。

**两个此前从未注册的兵团市（用户报告「塔城左边空了一大块」的答案）**

cn-atlas 的 `prefectures` 在新疆有两个面**不在** `units.json` 白名单里，于是它们的区域不属于任何单位、渲染为空白：

| adcode | 名称 | 面积 | 中心 | 成立 | 从谁划出 | 原空白块 |
|---|---|---|---|---|---|---|
| 659012 | 白杨市 | 2550 km² | 82.508,45.933 | 2023 | 塔城地区 | 塔城西侧，正是用户指出的那块 |
| 659011 | 新星市 | 593 km² | 93.718,42.684 | 2021 | 哈密市 | 哈密 560 km² 的洞（中心 93.777,42.696，与本市 0km 偏移） |

两者均为 `decorative: true`（不参与出题），加入后互为邻居关系被自动重建：白杨市↔塔城地区、新星市↔哈密市。

**为什么必须 explode**：mapshaper 的 `keep-shapes` 只保证「整个 feature 不消失」，**不保护 MultiPolygon 内部的孤立小环**。实测淮北（340600）含一个约 39.7km² 的飞地小环，在 8%/4% 简化下该环被删除 → 其弧拓扑被改写 → 与徐州（320300）的共享弧消失 → 0.135° 可见缝隙。explode 后每个小环成为独立 feature，受 `keep-shapes` 保护，实测各档零共享均为 0。

**闸门判据必须是「源拓扑 arc 共享」，不能用几何距离**（2026-09 第三次修正）

前两版闸门都按几何找「相邻对」，需要一个「多近才算相邻」的容差，而**实测不存在能用的阈值**：

- 用「近邻顶点计数」：凉山彝族自治州(513400)↔曲靖市(530300) 恰好凑够 3 个近邻顶点被误判为相邻（几何最近 0.645km）。把分布拉出来看，「有共享顶点」组 near∈[3, …]、「零共享」组 near∈[1,7]，**两组重叠**，任何阈值都会误报。
- 用「贴合边界长度」（尺度无关）：仍有 2 对零共享（凉山↔曲靖 5.86km、三亚↔五指山 0.87km），而真有共享的对最短 1.37km —— 依然重叠。
- 且与 `units.json` 的 neighbors 字段交叉验证也**不能**自证：该字段由本管线自己用 fine 档几何生成，两个角点相接的单位本来就互不为邻居，用它当基线等于循环论证。

根因是这两对**本就不相邻**：直接读源 TopoJSON 的 arc 引用，凉山↔曲靖、三亚↔五指山 各共享 **0 条 arc**（阳性对照：北京↔天津共享 4 条、塔城↔白杨共享 4 条、哈密↔新星共享 2 条）。改用「源里共享 ≥1 arc 的 970 对 ⇒ 产物里必须共享 ≥1 顶点」后，判据变为**确定性、无容差**的，实测五档均 970/970 通过；且因共享 arc 只被简化一次，公共边界上每个顶点逐字相同，实测**最短公共边界 0.47~0.63km，共享顶点 ≤1 的对 0 个** —— 共享顶点确实等价于共享整段边界。

- 原始 DataV 下载管线 `scripts/build-data.mjs` 与逐面简化 `scripts/simplify-data.mjs` 已弃用/删除（逐面 Douglas-Peucker 会破坏共享边，是缝隙的另一成因）。

### 4.3 运行时加载
- 地级五档与省级五档**全部以 TopoJSON 存储**，运行时 `topojson-client` 转 GeoJSON 后 `registerMap`（ECharts 不吃 TopoJSON）。**装饰面已并入拓扑，运行时不再单独请求 `china_decorative.geojson`**。
- 运行期实际同步加载 14 个文件（`Promise.all` 并行）：地级五档（124 / 158 / 215 / 416 / 908KB）+ 省级五档（43 / 58 / 84 / 174 / 396KB）+ `hkmac.geojson` 125KB + 元数据 `units.json` 84KB / `countries.json` 30KB / `world.geojson` 298KB。合计 **3114KB**。
  - 对比：上一版（三档 + 省级两档 GeoJSON）为 3852KB —— 本轮**反而小了 738KB**，因为省级改用 TopoJSON。新增两档的净增量（地级 +574KB、省级 +232KB）远小于格式优化省下的量。
  - **内存代价（实测，非估算）**：五档全部展开后地级 304,311 顶点 + 省级 121,729 顶点 = 426,040 顶点，`heapUsed` 增 **34.5MB**（约 85 字节/顶点）。相对上一版三档（地级 214k 顶点）多约 9.4MB。这些顶点常驻是刻意的取舍 —— 换档时不重新解析 JSON，缩放跨阈值无网络/解析抖动；单档顶点数仍由视口裁剪限制（见 4.4）。
- 无损档 `china_units_lossless.json`（908KB）与其他档一样**同步加载**；卡顿由**视口裁剪**解决而非异步加载（详见 4.4）。
- 港澳放大框 `hkmac.geojson`（125KB）同步加载，`InsetMap` 始终渲染无压缩三面；`InsetMap` 另从 `provincesGeoJson`（fine 档）取省界。
- **档位判定集中在 `src/map/tiers.ts`**（纯逻辑、无 ECharts/DOM 依赖，便于单测），`renderer.chinaTierMapName()` / `provinceTierMapName()` / `activeProvinceLines()` 三者都经 `tierOfZoom()` 推导，不会出现「地级改了阈值、省级忘改」的漂移。阈值：`ultra <2`、`pro 2~6`、`fine 6~10`、`plus 10~14`、`lossless ≥14`；钻省时强制 `lossless`（视口只剩一个省，顶点再多也被裁剪挡住）。
- 切换时 `setOption` 必须带 `replaceMerge: ['geo','series']`，否则 geo 停留在上一档绘制状态导致空白。
- **跨档一致性是不变式**（`src/tierConsistency.test.ts` 守着）：ECharts 按 `feature.properties.name` 建 region，着色 / 点击命中 / 标签锚点全靠这个名字。五档的 name 集合与 adcode↔name 映射必须**完全相同**，否则跨阈值换档时该单位会突然丢色或点不中。

### 4.4 视口裁剪（只渲染当前视角范围）

**问题**：放大到 zoom ≥ 14 使用无损档后拖动卡顿。根因不是「可见面积大」，而是 **zrender 每帧对每个 Path 重算 `buildPath`，开销 ∝ 顶点数**，与是否落在视口内无关。实测把省界线整个删掉，无损档每帧仍有 15.9ms，证明是顶点数而非可见性驱动开销。

**决定性机制**：`zrender/lib/Storage.js` 的 `_updateAndAddDisplayable` 在元素 `ignore === true` 时**第 52 行提前 return**，位于 `el.update()`（即 `buildPath`）**之前**。因此给整棵子树设 `ignore` 即可跳过其路径构建与绘制，代价 O(1)，且**无需 `setOption`**，所以不会产生重建卡顿。注意 ECharts 自带的 `culling: true`（见 `MapDraw.js`）只在 `shouldBePainted()` 里跳过绘制，`buildPath` 照跑，因此对顶点密集的省界无效。

**实现**（`src/map/cull.ts`）：
- 视口换算：用 `geoCoordSys.pointToData()` 取画布四角 → 数据坐标 bbox。投影经 `boundingCoords` 钉死后 lng/lat→像素为线性映射，四角即覆盖整个视口。
- 地级面：递归/`getViewOfComponentModel` 取到 MapDraw 的 `_regionsGroupByName`（HashMap），按 `cs.getRegion(name).getBoundingRect()`（内部缓存 `_rect`）与视口 bbox 求交，设 `group.ignore`。
- 省界线：`data.getItemGraphicEl(i).ignore`。逐元素 bbox 在 `buildLineData()` 构建时算一次（`LineRenderer.lineBoxes`），逐帧只做区间比较。
- 调用点：`render()` 末尾（replaceMerge 会重建 region 组、清掉 ignore）、`georoam`（视口移动）、`applyMapCamera()` / 跟随动画每帧 / `drill()` / `backToNation()`（这些直接写相机、不触发 georoam）、`resize()`（画布尺寸变）、`flash()`（高亮改 `geo.regions` 同样会重建 region 组）。**凡是会重建 geo/region 组或改变画布尺寸的路径，都必须在其后补一次裁剪**，否则 ignore 标记被清空、裁剪收益静默丢失。
- 外扩系数 `CULL_MARGIN = 1.5`：为帧间位移留余量，实测该余量下不露底、不误裁。

**实测**（1600×1000，中心广州，标签开，4 轮交错取各配置最小值以消除逐轮漂移）：

| 配置 | zoom 10 | zoom 12 | zoom 16 |
|---|---|---|---|
| 无损 + 裁剪 | **6.8ms** | **13.2ms** | **11.3ms** |
| 无损 无裁剪 | 15.8ms | 28.2ms | 27.7ms |
| 压缩 33% + 省界无损（改前的线上方案） | 17.2ms | 34.6ms | 35.8ms |

即：**裁剪让无压缩的无损档比「压缩 33% 但省界仍无损」的旧方案快 2.5–3.2 倍**，且精度零损失。裁剪刷新成本约 面 1.2ms + 线 0.1ms（远低于 `setOption` 重建 series 的 33.7ms），故可每帧执行而不卡顿。省界线的开销（69k 顶点）大于地级面，故线裁剪（0.1ms）收益最大。

**露底验证（像素级）**：对 9 个场景（全国 z1 / 珠三角 z6 / 广州 z12 / 广州 z22 / 乌鲁木齐 z12 / 哈尔滨 z12 / 拉萨 z12 / 最南端 z12 / 省级 z4）逐像素比对「裁剪渲染」与「同一状态放开裁剪的全量渲染」，差异像素**均为 0**，且被裁面数最高达 369/371。另做**阳性对照**：故意误裁 1 个可见面 → 探针报出 15560 个差异像素，证明该比对确能感知误裁（排除「0 差异」实为探针失效）。边界情形（高亮 / 换档 / 省级 / 世界 / 下钻 / 返回全国 / resize / 换主题）9/9 通过 —— 该组用例曾查出两个真实缺陷：`flash()` 的 `setOption({geo:{regions}})` 与 `resize()` 都会清空 ignore 标记，已在二者后补 `cullToViewport()`。

## 5. 地名匹配引擎

### 5.1 规范化 normalize(input)
1. 去首尾空白、全角→半角、统一小写。
2. 剥离行政后缀：`市 / 地区 / 自治州 / 盟 / 州`（"黔南州"→"黔南"）。
3. 剥离民族限定词表（约 50 词）：布依、苗、侗、壮、回、藏、蒙古、彝、哈尼、傣、傈僳、佤、拉祜、水、纳西、景颇、达斡尔、鄂温克、鄂伦春、哈萨克、柯尔克孜、锡伯、塔吉克、乌孜别克、俄罗斯、满、土家、白、瑶、朝鲜、黎、畲、高山、赫哲、撒拉、东乡、裕固、保安、门巴、珞巴、羌、毛南、仫佬、仡佬、京、独龙、德昂、阿昌、普米、怒、基诺、布朗、维吾尔。
   - 示例：`黔南布依族苗族自治州` → 去民族词 → `黔南自治州` → 去后缀 → `黔南`。
4. 别名表兜底：大理→大理白族自治州、凉山→凉山彝族自治州、延边→延边朝鲜族自治州、阿坝、甘孜、湘西、恩施、临夏、海西、伊犁 等（随数据生成时可自动推导大部分，别名表只补特例）。

### 5.2 模糊匹配 match(input, units) → 候选列表（带分值）
1. 精确匹配（规范化后全等）——最高分
2. 前缀匹配
3. 包含匹配
4. 编辑距离 ≤ 2 容错（错别字："黔南洲"、"屏顶山"）
5. 拼音/首字母匹配（二期扩展）

### 5.3 消歧（多候选 → 强制下拉确认）
- `海南`：海南省（省条目）vs 海南藏族自治州（青海）→ 两个候选都展示，用户选择。
- `吉林`：吉林省（省条目）vs 吉林市（吉林省）。
- 规则：**单候选直接命中；多候选必须下拉选择**，候选展示"完整官方名 + 所属省"，全名展示本身即学习过程。
- 省级条目特殊处理：输入命中省级名称（如"海南""北京"）时，额外生成"省条目"候选——确认后展示该省下属单位列表供二次选择（不自动标记整省，避免误操作）。

## 6. 渲染层（ECharts）

- `echarts.registerMap('china', chinaUnitsGeoJSON)`，name 字段 = 单位全名（地级用官方全名，整体单位用"北京"等）。
- series-map，`roam: true` 支持缩放平移；`label.show` 在缩放级别较高时显示名称。
- **着色状态**（itemStyle 按 adcode 查记忆状态）：
  - 未记忆：浅灰 `#e8e8e8`（边框 `#b0b0b0`）
  - 已记忆：绿 `#34c759`
  - 悬停（emphasis）：亮黄 `#ffd60a`
  - 刚确认命中：播放一次高亮动画（emphasis + 定时恢复）
- 交互事件：
  - 搜索确认 → `dispatchAction` 缩放至该单位（center + zoom），着色更新
  - 点击区域 → 弹出信息卡（全名/简称/所属省/记忆状态/记忆时间），提供"标记为已记忆"按钮
  - 悬停 → 显示名称 tooltip
- 无需处理坐标系偏移（纯矢量，GeoJSON 坐标原样绘制）。

## 7. UI 设计（MVP）

```
┌────────────────────────────────────────────┐
│ 顶部: [搜索框: 输入地名…]  [进度: 12/340 ▓▓▓░] │
├────────────────────────────────────────────┤
│                                            │
│                 ECharts 地图                │
│        （全国地级边界，按记忆状态着色）          │
│                                            │
├────────────────────────────────────────────┤
│ 侧栏: 已记忆列表(最近) / 按省进度 / 重置按钮     │
└────────────────────────────────────────────┘
```

- 搜索框：输入即出候选（防抖 100ms），↑↓ 选择、Enter 确认、Esc 关闭。
- 候选条目：`黔南布依族苗族自治州 — 贵州省`。
- 统计面板：已记忆 X/340、进度条、按省分组进度、最近记忆（时间倒序）、一键重置。
- 配色固定、色盲友好（灰/绿/黄对比度足够）。

## 8. 状态层（localStorage）

```ts
interface MemoryState {
  [adcode: string]: {
    learned: boolean;
    firstLearnedAt: number;   // 首次记忆时间戳
    reviewCount: number;      // 复习次数（二期用）
    lastReviewAt: number;     // 最近一次时间戳
  };
}
```

- key：`china-memory-state-v1`；读写封装在 `memoryStore.ts`；支持导出/导入 JSON（二期）。
- 每次变更触发统计面板刷新（事件订阅，无框架用简单 pub/sub）。

## 9. 项目结构

```
地图记忆/
  package.json
  vite.config.ts
  index.html
  scripts/
    fetch-cn-atlas.mjs    # 抓取 cn-atlas TopoJSON → explode+拓扑保持简化四档 + 无损档 + 重建元数据 + 源拓扑闸门（一次性）
    fetch-world-data.mjs  # 世界数据（含 CONTINENT_OF 大洲归属表 → countries.json 的 continent）
    check-data.mjs        # 数据校验（逐面几何 + 单位覆盖 + 邻接零共享 + 空洞是否被填）
  public/
    data/
      # ── 地级五档（精细度阶梯，zoom 区间见 DESIGN 4.2）──
      china_units_ultra.json        # 地级 ultra  4%（TopoJSON，zoom < 2）
      china_units_pro.json          # 地级 pro    8%（TopoJSON，2 ≤ zoom < 6）
      china_units.json              # 地级 fine  15%（TopoJSON，6 ≤ zoom < 10）
      china_units_plus.json         # 地级 plus  40%（TopoJSON，10 ≤ zoom < 14）
      china_units_lossless.json     # 地级无损 100%（TopoJSON，zoom ≥ 14 或钻省）
      china_units_coarse.json       # 地级 8% 历史别名（内容 = pro，保留兼容旧缓存）
      # 注：china_decorative.geojson 已退役（装饰面并入地级拓扑），管线会删除，check-data 会报错
      # ── 省级五档（与地级同一套阈值与比例）──
      china_provinces_ultra.json    # 省级 ultra  4%（TopoJSON，zoom < 2）
      china_provinces_pro.json      # 省级 pro    8%（TopoJSON，2 ≤ zoom < 6）
      china_provinces.json          # 省级 fine  15%（TopoJSON，6 ≤ zoom < 10）
      china_provinces_plus.json     # 省级 plus  40%（TopoJSON，10 ≤ zoom < 14）
      china_provinces_raw.json      # 省级无损 100%（TopoJSON，zoom ≥ 14）
      # 以下两个仅服务「旧 index.html + 旧 hash bundle」的缓存用户，新 bundle 不读
      china_provinces.geojson       # 省级 fine 档展开成 GeoJSON（历史文件名）
      china_provinces_coarse.geojson # 省级 ultra 档展开成 GeoJSON（历史文件名）
      hkmac.geojson                 # 港澳放大框无压缩面（广东+香港+澳门，始终不简化）
      countries.json                # 195 国元数据（含 continent 大洲字段）
      units.json
  src/
    matcher/
      normalize.ts        # 规范化（去后缀/民族词/别名）
      match.ts            # 模糊匹配 + 消歧
      units.ts            # 元数据索引加载、简写索引构建
    map/
      renderer.ts         # ECharts 初始化、registerMap、着色、缩放
      cull.ts             # 视口裁剪（只渲染当前视角范围内的面与省界线）
      colors.ts           # 配色常量
    store/
      memoryStore.ts      # localStorage 封装 + pub/sub
    ui/
      searchBox.ts        # 输入框 + 候选下拉
      statsPanel.ts       # 进度统计
      infoCard.ts         # 区域信息卡
    main.ts               # 装配
```

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| DataV 接口失效/403（[referrer 限制](https://blog.csdn.net/java5/article/details/154324760)） | 一次性下载打包进项目，运行时零网络依赖 |
| 数据体积大 | mapshaper 简化几何；必要时按省拆分下钻 |
| 直辖市/港澳/台湾无地级层 | 已定义整体单位口径（§2），UI 信息卡标注"省级单位" |
| 名称歧义（海南/吉林） | 多候选强制下拉确认（§5.3） |
| 区划近年变动（新疆新设地级市） | 数据由脚本从官方文件生成，不硬编码数量 |
| ECharts 大数据量渲染性能 | 373 个面规模很小，无压力；简化后更稳 |

## 11. 里程碑

- **M1 数据管线**：fetch-cn-atlas.mjs 抓取合并 → 验证 GeoJSON 正确、元数据表完整（373 单位，含 33 个装饰面）
- **M2 渲染层**：ECharts 全国地图 + 着色 + 缩放 + 点击信息卡
- **M3 匹配引擎**：normalize + match + 消歧 + 搜索框候选下拉
- **M4 状态统计**：localStorage + 统计面板 + 高亮动画 + 重置
- **M5（二期）**：测试模式（看名点图/看图写名）、间隔复习、拼音输入、进度导入导出

## 12. 验收标准（MVP）

1. 输入"黔南"→ 地图上黔南布依族苗族自治州变色为绿，进度 +1，刷新后状态保持。
2. 输入"恩施土家族苗族自治州""黔南州""海南"等 → 正确命中或给出可消歧候选。
3. 输入错别字（编辑距离 ≤2）→ 给出容错候选。
4. 点击任意区域 → 信息卡显示全名/所属省/记忆状态，可手动标记。
5. 统计面板数字与地图着色一致；重置后恢复初始。

---

## 13. 四模式需求设计（v2 用户需求定稿）

> 本节约束并扩展上文 §7/§11/§12。MVP 范围调整为：**四种模式全部实现**。

### 13.1 模式
1. **自由模式**：点击地图区域或输入地级市名称（回车确认）。输入正确 → 标记绿色；输入错误 → 清空输入框、状态不变。无时间限制、无固定顺序。绿色状态持久化（localStorage）。
2. **自测模式（BFS 扩张）**：随机起点标蓝 → 立即转红成为题目，用户输入名称。答对 → 变绿；答错 → 保持红色（错误标记）。下一个蓝点 = 与上一个答对的绿点**相邻**的地级单位（优先同省），本质 BFS；无相邻候选时回退到最近未测单位（岛屿如三沙、台湾）。倒计时默认关闭，设置中可开启并设定秒数。
3. **挑战模式**：随机标红一个地级单位，用户输入名称。答对 → 变绿并立即随机出下一题；答错或超时 → 保持红色并跳过。默认每题 10 秒，设置中可调。
4. **记忆模式**：全图显示所有地级市名称（标签在区域中心），纯浏览、无交互（仍可缩放/下钻）。

### 13.2 统一配色
| 颜色 | 含义 |
|---|---|
| 🟢 绿 | 已完成/正确 —— 变绿即显示地名标签（区域中心） |
| 🔵 蓝 | 当前待测目标（仅自测模式，短暂预览） |
| 🔴 红 | 当前题目 / 答错标记 |
| ⚪ 灰 | 未涉及 |

### 13.3 通用能力
- 任意模式可自由缩放（ECharts roam）。
- **自由拖动**：地图四周边界**不钳制**，用户可把地图随意移出视口（`clampPan` 已移除，仅保留 resize/标签刷新等 roam 副作用）。
- **省份下钻**：选择省份 / 双击区域 → 其他地方消失（透明），仅保留该省并自动缩放居中；"返回全国"恢复。
- 设置面板：自测倒计时开关+秒数、挑战每题秒数；localStorage 持久化。

### 13.4 实现要点（相对上文的变化）
- 邻接数据：build-data.mjs 用 turf `booleanIntersects`（bbox 预过滤）计算全国地级单位相邻关系，存入 units.json `neighbors`，BFS 扩张直接使用。
- 测试模式（自测/挑战）为会话级状态，切换模式或刷新即重置；自由模式进度单独持久化。
- 测试模式输入框关闭联想（防止答案泄漏），用同一匹配引擎判定对错（如输入"黔南"可答"黔南布依族苗族自治州"）。
- 直辖市/港澳/台湾为整体单位，与 333 个地级单位一起参与四种模式。

---

## 14. v3 修订（用户反馈定稿）

1. **配色语义调整**：🔵 蓝 = 当前题目（自测/挑战的提问目标）；🔴 红 = 仅答错标记；🟢 绿 = 正确/已记忆；⚪ 灰 = 未涉及。自测模式的"蓝色预告"概念取消（蓝即题目）。
2. **省直辖县级填充面**：海南 15 个直辖县、湖北仙桃/潜江/天门/神农架、河南济源、新疆兵团城市等县级区域以灰色装饰面补齐地图空白（修复"海南等区域看起来没加载"的问题），不参与匹配/统计/测试。**它们现在直接取自 cn-atlas 的 372 个 `prefectures` 面**（2026-09 单一来源改造），与地级面本就在同一套弧拓扑里，随各档一起简化、一起参与邻接计算；`decorative: true` 仅用于配色与出题排除。详见 4.2。
3. **省界**：geo 组件作为唯一坐标系（`map: 'china'` 地级数据，自身全透明），地级 series 绑定 `geoIndex: 0`（着色/细边界/标签全部正常）；省界由**同一坐标系的 lines 线条系列**绘制粗线（2.4px 深灰，339 条省界线，z 在地级之上）——单视图、无重叠、不隐藏地级边界；下钻省份时省界线只保留当前省。修复记录：series 绑定 geoIndex 后 `getMapType()` 取 geo 的 map，若 geo.map 用省界数据会导致地级名与省 region 不匹配、地级面整体消失（"地级边界被隐藏"bug），故 geo.map 必须用地级数据。
4. **地名标签**：白底标签（backgroundColor #fff + 状态色边框/字体）：绿=已记忆、红=答错、记忆模式=中性深灰；字号 12；标签位于区域中心；**题目（蓝）不显示标签**（防答案泄漏）。
5. **缩放分级标签**：zoom < 2.5 时**不显示任何标签**（省名标签已取消）；zoom ≥ 2.5 显示地级标签，防止扎堆；缩放通过 geo 组件的 `georoam` 事件 + `rendered` 兜底读取 zoom，跨阈值才重绘。
6. **取消输入联想下拉栏**：搜索框回车直接匹配（地级优先：`bestUnit`；未命中再试省名 `bestProvince` → 下钻）。"海南"→ 海南藏族自治州（地级优先）；"海南省"→ 下钻。
7. **数据简化策略（四档 + 无损档 + 视口裁剪，拓扑保持 + explode + 单一来源）**：数据源 2026-09 从阿里 DataV 换成 cn-atlas（TopoJSON 共享弧，相邻边 0% 零共享，根治地图缝隙）；全部 372 个 `prefectures` 面（地级 + 县级/兵团市，本在同一套弧拓扑里）整体取用，**不做 `-snap`/`-clean` 缝合**（该步骤会在面上开洞造成露白，详见 4.2），只额外补入 cn-atlas 没有的南海诸岛面。地级地图按 zoom 分五档（无损 ≥14 / plus 10~14 / fine 6~10 / pro 2~6 / ultra <2），省级同用一套阈值，简化档由 mapshaper `visvalingam keep-shapes` 拓扑简化（共享弧只简化一次，不产生缝隙），最精细档**完全不简化**，其流畅度由**运行时视口裁剪**保证（见 4.4）——
   - **无损档** `china_units_lossless.json`：100% 顶点（约 9.7 万顶点，908KB），zoom ≥ 14 或已钻省时使用；同步加载，**不做任何简化**，靠视口裁剪把每帧 `buildPath` 限制在可见子集；
   - **plus 档** `china_units_plus.json`：keep 40%（416KB），10 ≤ zoom < 14；
   - **fine 档** `china_units.json`：keep 15%（215KB），6 ≤ zoom < 10；
   - **pro 档** `china_units_pro.json`：keep 8%（158KB），2 ≤ zoom < 6；
   - **ultra 档** `china_units_ultra.json`：keep 4%（124KB），zoom < 2（最简略，全国全景）；
   - **省级**同样五档（43 / 58 / 84 / 174 / 396KB，均以 TopoJSON 存储），与地级共用阈值；省界折线（`activeProvinceLines()`）也随同一档位切换。档位判定集中在 `src/map/tiers.ts`。
   - 补 pro / plus 的原因见 4.2：原三档把 4%→15%→100% 拉得太开（2.6x / 5.8x），10~13 倍率偏糙而 14 倍后骤精细；按几何中点补 8% 与 40% 后落差降到 1.9x / 2.0x / 2.4x。
   - **港澳放大框** `hkmac.geojson`：从省级无压缩几何抽取广东+香港+澳门三面，**始终不简化**（香港 283 顶点 vs fine 71、广东 2934 vs fine 553）。
   档位切换在 zoom 停止变化后防抖触发（`georoam` → `scheduleLabelModeUpdate`），切换走 replaceMerge 重建，各档 feature 属性一致故着色/点击/标签完全通用；拖动动画期间 map 固定起点档，动画结束再统一换档，避免帧间合并式切图触发 ECharts 空白 bug。运行时 `topojson-client` 转 GeoJSON 再 `registerMap`（ECharts 不吃 TopoJSON）；全部 373 个面（372 cn-atlas + 南海诸岛）在**同一套弧拓扑**里一起简化、一起参与邻接计算。管线：`scripts/fetch-cn-atlas.mjs`（含源拓扑闸门）；校验：`scripts/check-data.mjs`。
   - **为什么用「裁剪」而不是「压缩顶点」**：放大后的卡顿 ∝ 顶点数（zrender 每帧重算 `buildPath`），与可见面积无关 —— 实测删掉整个省界线后无损档每帧仍有 15.9ms。裁剪不改任何顶点（精度 100%），只把不可见子树设 `ignore` 以跳过路径构建与绘制，代价 O(1) 且不需要 `setOption`（故无重建卡顿）。实测无损+裁剪（13.2ms @zoom12）优于「压缩 33% + 省界无损」（34.6ms），也优于任何简化档的全量渲染。详见 4.4。
   - **explode 必要性**：`keep-shapes` 不保护 MultiPolygon 内部孤立小环（淮北 340600 的 39.7km² 飞地在 8%/4% 档被删 → 与徐州 320300 产生 0.135° 缝隙）。管线先 `-explode` → 简化 → 按 adcode 合并回 MultiPolygon，各档零共享均为 0。注意 ECharts `parseGeoJson` 对每个 feature 单独建 region 且**不合并同名 feature**，故合并回 MultiPolygon 是必需的，否则同一地级市只有一块面被着色。
   - **固定投影范围（boundingCoords）**：ECharts 默认按**当前注册地图的几何 bbox** 自动适配投影，而各简化档的 bbox 并不严格相同（ultra/省级粗档把南海诸岛最南端简化掉，纬度下界 3.3974 → 3.5349，高度少 0.1375°≈15km）。bbox 一变投影比例与居中偏移就变 → 缩放跨换档阈值时整幅地图微移、鼠标所指位置偏移。实测换档偏移 **13.8px**（这就是"跨档缩放时地图小幅度移动"的根因）。修法：`geo.boundingCoords` 钉死投影范围为常量（`MAP_PROJECTION_BBOX`），中国族各档与地级/省级两族共用同一投影。修复后偏移降至 **0.003px**（zrender 取整噪声量级）。注意 bbox 完全相同的两档（如 fine↔pro）本来就无偏移，问题只出在把南海诸岛最南端简化掉的粗档上。
   - **换档 center 同步（georoam 读 geo 权威中心）**：缩放仍存在水平方向微移的**第二个独立根因**。ECharts 滚轮/捏合缩放以**鼠标为锚点**，缩放时 geo 中心会隐式移动（锚点缩放），但 zoom 事件的 payload 只含 `zoom`/`totalZoom`，**不含 center**（见 `MapDraw.js` 的 zoom dispatch：仅 `{totalZoom, zoom, originX, originY}`）。若 georoam 处理器只靠 payload 里的 `params.center` 同步，`this.center` 会在缩放期间停留在旧值 → 跨换档阈值 `render()` 用旧 center 重建 geo，地图朝缩放锚点方向跳十几像素。修法：georoam 里直接从 geo 坐标系读 ECharts 已更新好的权威 `getCenter()`/`getZoom()`（georoam 事件在 `geoRoam` action 处理完、`updateCenterAndZoom` 已写回 center 之后才触发，故此刻读到的必为缩放后最新值）。实测 pan/zoom/混合三种路径 rc 与 geo 中心 mismatch 恒 0，跨档锚点误差 0px。注意不能用 `chart.getCoordinateSystems()`（其返回的 geo 对象可能滞后），须用 `getModel().getComponent('geo').coordinateSystem`（TS 下 getModel 是私有，需 `as unknown as` 强转）。

8. **世界粒度的大洲范围（六洲，不含南极洲）**：世界粒度下在「世界/省级/市级」按钮**下方**再出一行分段按钮「全世界 | 亚洲 | 欧洲 | 非洲 | 北美 | 南美 | 大洋洲」。
   - 大洲归属由 `fetch-world-data.mjs` 的静态 `CONTINENT_OF` 表（iso_a3 → AS/EU/AF/NA/SA/OC）写入 `countries.json` 的 `continent` 字段，不引入额外几何数据。跨洲国家按地理教科书口径：俄罗斯/土耳其/塞浦路斯 → 欧洲，高加索三国/哈萨克斯坦 → 亚洲，埃及 → 非洲，巴拿马 → 北美。分布 AF 54 / AS 46 / EU 46 / NA 23 / SA 12 / OC 14 = 195。
   - 选某洲后：出题池缩到该洲国家（`worldScopedPool`），地图只渲染该洲面（其他洲隐藏，`worldFeatureVisible` 同时过滤 region/事件/标签），并聚焦该洲。
   - **聚焦框为手工标定**（`CONTINENT_VIEWS`），不按成员国 bbox 自动计算：跨经线 180° 的海外领地（俄楚科奇、美阿留申、法属波利尼西亚）会让 bbox 撑成 360°，且俄罗斯按惯例归欧洲而主体横跨 20°E–180°E，「包含全部成员」必然把欧洲拉宽到 200°+。标定值确定可测；框外领地仍可拖动到达（roam 已开）。
   - 大洲用**独立排行榜哨兵** `__continent_<ID>__`（如 `__continent_AS__`，榜名「亚洲榜」），但**熟练度与世界数据集共享**（已答国家在大洲/全世界两种范围下都是绿色）。进度持久化也用独立键（`…:world-continent-AS`）。
   - 未开始测试时点击某国 → 下钻其所属大洲；已开始 → 正常判题（国家是世界的原子单位）。
   - 后端白名单同步放行该哨兵（`functions/_lib/validate.ts` 的 `isContinentScope`），排序与提交规则同「全国语义」（答对题数优先、允许未答完但必须全对）。
   - 按钮布局：洲按钮放在 `#mode-actions` **末尾**，由零高度换行占位 `#continent-break`（`flex-basis:100%; height:0`）推到下一行并保持**内容宽度**。不要用 `flex-basis:100%` 直接加在洲按钮上——那会把它拉伸到屏宽，并把「顺序/重置」挤到第三行。占位元素随洲按钮一同显隐（`chromeSync.syncSegments`），否则非世界粒度时会凭空多出一个空行。
