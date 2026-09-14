# 给下一个 AI 的交接文档

## 本轮补丁（用户三条口径）：叠放按组、容差分档、吸附方向

1. **叠放改成"先组、后片"**（`view.renderStructure`）：排序键 `(组总面积 desc, 片自身面积 desc, groupId, adcode)`，两组面积都写进 DOM（`data-area` / `data-group-area`）。于是**许多小碎片拼成的大块会沉到中层碎片之下**（组面积 = 组内各片之和），组内仍旧小的压在大的之上（北京/天津在河北的环里）。实测验收输出：`{河北+北京} 组面积 21.45` 排在 `湖北 15.27` 之前，组内 河北(19.71) → 北京(1.73)。
2. **磁吸容差按难度分档**（`state.SNAP_TOLERANCE_PX = { easy: 10, hard: 5 }`，原统一 15px）：用户自定义口径是「困难档收紧为 5px，简单档收紧为 10px」。难度运行中锁定，所以 `ensureState()` 建一次即可；提示范围与容差同值。真机验收覆盖：简单档 8px 吸上、困难档 8px 不吸而 4px 吸上。
3. **松手方向反转**（`state.drop`）：**拖拽方主动吸附过去** —— `root.dx/dy = target.dx/dy`（原来是 `target.dx = root.dx`）。连锁时每吸一组就跳到那一组的位置，最终停在**最后吸上的那一组**的偏移上。
   ⚠ 副作用（已写进单测）：**"桥接"不再可能** —— 手里那片没法同时够到两个相距超过容差的组（因为它一吸上就跑到目标的偏移上了）。单测 `一次放下可能连锁吸收两个组` 因此改用"京津冀模型"：两片彼此**不相邻**、但都与手里这片相邻，且彼此在容差内。
4. **简单档提示只留边界**（`styles.css`）：删掉 `.can-snap .puzzle-piece` 的 `fill/fill-opacity`，保留 2.5px 绿描边 + `drop-shadow` 绿辉光；验收断言目标片 `fill` 与普通灰面完全相同。

**验收**：tsc 0；vitest **273/273**；`verify-puzzle.mjs` **75/75**（新增：组面积叠放两级断言、拖拽方吸附方向、简单档边界荧光无填充、简单 10px / 困难 5px 三档容差行为）；verify-round2 38/38；verify-round3 38/38。

## 上一轮补丁（用户报缺陷）：市级档点地级单位没有收窄范围

**症状**：市级档（全国 340 片）里点一个地级单位，**地图确实钻进了那个省**，但拼图范围仍是「全国 340 个地级单位」；点空白"能回到上层"（其实只是地图回去了，范围从头到尾没变）。

**根因**：模式的 `onUnitClick` 在市级档直接 `return false`，于是事件落到 renderer 的**兜底下钻**上 —— 那条路只改**地图视图**（`drillToProvince`），模式自己的 scope 一点没动。省级档之所以没这个问题，是因为它在模式里显式调 `drillFromProvinceNation`。

**修法**（`src/modes/puzzle.ts`）：
1. 中国侧统一成一个目标：省级档 → 点到的省；市级档 → `drillTargetOfUnit(data, adcode)`（**它所属的省**）。合法就 `scope = target` + `enter()` 并返回 `true`（把事件收下，别让 renderer 再兜底）；唯一层级省级单位仍然只给提示。
2. `drillTargetOfUnit` 改成查 **`allUnits`**：省直辖县级市/兵团城市是**可点的装饰面**，只查 `units` 会让它们退化成"自己当省"，钻出一个没有下级单位的空范围。
3. 反向同步：`renderScopeMap()` 在市级档且无范围时，因为 `setProvinceMode(false)` 会提前 return（本来就是这个状态），renderer 里残留的下钻省不会被清 —— 必须判 `renderer.currentProvince()` 后调 `backToNation()`。**这个判断同时是防重入的**：`backToNation()` → `onViewChange` → 模式 `refresh()` → 又回 `renderScopeMap()`，不判就无限递归（实测 ECharts `_buildGeoJSON` 里 stack overflow）。
4. `setGranularity(g)` 允许**点已选中的档位**：此时把范围重置回该档的全国范围（市级档下钻某省 → 再点「市级」= 回到全国 340）。粒度行因此也是"退出下钻"的出口。

**顺带**：`probe.ts` 新增只读快照 `quizScope()`（模式/粒度/范围哨兵/出题池大小/大洲/次区域/地图下钻省），用来分辨"地图下钻"与"范围收窄"这两件事 —— 以后凡是涉及下钻的断言都该看它。

**验收**：vitest 271/271；`verify-puzzle.mjs` **70/70**（新增：市级全国点一个地级单位 → 范围变 6 位 adcode、副标题写「把四川的 21 个地级单位」、开局片数 21 且进度行 `已拼 1/21`；点空白 → 回全国 340 且 `viewProvince === null`；点已选档位 → 回全国）。

## 上一轮（拼图收口：1x 比例尺、困难档无提示、下钻边界、拼图排行榜）

需求（用户一次给了 6 条）：

1. **拼图 1x 的大小要和其他模式 1x 一致**。
2. **困难档不给任何绿色（吸附）提示**，避免撞运气。
3. **直辖市不允许下钻（所有模式都是如此）**。
4. 拼好后显示「**拼图完成**」。
5. **所有模式下取消世界中大洋洲的进一步下钻**。
6. **拼图模式加排行榜**：世界 194 国与全国地级市级按**拼好的个数**排名、个数相同按时间；允许中途终止提交；其他层级中途退出不弹提交。

### 两轮 grill 定稿的口径（本轮问题都在 `grill-rounds.log` 里）

- **1x（Q1）**：严格一致 —— 拼图 1x = 地图 zoom=1 的比例，**与范围无关**；进入范围时默认视角就是 1x；缩放范围扩到与地图一致的 **0.8–28x**，缩放角标重新显示。实现见 `unitScale()`：`min(0.8W/spanLng, 0.8H/(spanLat·1.3333))`（0.8 = 地图 geo 的 10% 内缩）。实测：地图 8.904 px/°（中国族）/2.575（世界族），拼图同屏读到 9.024/2.609（差 1.3%，来自两块容器高度差 ~10px）。
- **困难档（Q2）**：**完全没有任何吸附提示**（拖动中/点选幽灵预览/手里那块都不亮），规则与容差两档相同。
- **「拼图完成」（Q3）**：只把**完成卡片标题**改成「拼图完成」（顶部状态行保持「已拼 n/n ｜ 用时」）。
- **下钻范围（Q4）**：**京津沪渝 + 港澳台共 7 个唯一层级省级单位**都不下钻（不止 4 个直辖市），点击给一行提示；老存档停在这类范围时按全国处理。
- **大洋洲（Q5）**：只取消**次区域层** —— 大洋洲仍可选、可点国家进入，但不再显示/进入澳新·美拉尼西亚·密克罗尼西亚·波利尼西亚；四个哨兵与数据保留（ADR-0001）。
- **排行榜口径（Q6）**：「拼好的个数」= 顶部显示的**已拼**（1 + 吸附次数）；**已拼 ≥ 2** 才可提交；**复用「重置」→ 结算卡片**作为中途终止入口（拼完则在完成卡片上给「提交成绩」）；侧栏**所有范围都显示**，**运行中自动收起**。

### 关键实现位置

- `src/puzzle/projection.ts`：`unitScale(family, w, h)` + `GEO_LAYOUT_RATIO = 0.8`（1x 的唯一事实源，单测拿地图实测值 `0.11230425055928414 deg/px` 当闸门）。
- `src/puzzle/view.ts`：`MIN_ZOOM/MAX_ZOOM = 0.8/28`、`hints()` 选项（困难档 `applyHint` 直接清空）、`resetView()` 改成"1x + 居中当前范围"、`onZoom` 回调、`zoomLevel()`、`data-area` 供验收断言面积层级。
- `src/modes/puzzle.ts`：`getZoomDisplay()`（角标报自己的倍率）、`isPuzzleLeaderboardScope()`/`PUZZLE_MIN_SUBMIT`/`collectResult()`/`isRankedScope()`、`setTestRunning` 收起侧栏、`onUnitClick` 的两条下钻边界。
- `src/province.ts`：`SINGLE_UNIT_PROVINCES` / `canDrillProvince` / `drillTargetOfUnit`；`src/modes/progress.ts` 的 `loadScopeProvince` 会拒掉这类范围。
- `src/subregions.ts`：`NO_SUBREGION_DRILL = ['OC']`，`hasSubregions` 一处改动同时关掉界面的次区域行（chromeSync）、点击/输入与自由模式的下钻（mapQuizMode/analysis）、深链参数（applyScopeQuery）。
- 排行榜：`functions/_lib/validate.ts`（`MODES` 加 `puzzle` + 拼图专用校验分支 + `PUZZLE_SCOPES` + `isBetter`）、`functions/api/leaderboard.ts` 与 `score.ts`（走"全国语义"排序与 upsert 分支）、`src/scoreRules.ts`、`src/types.ts` 的 `RoundResult.mode`、`leaderboardStore/leaderboardPanel`（`拼图模式` 标题与「已拼 X/Y ｜ 用时」行尾）、`appController`（`isLeaderboardMode`、`showSettlementCard` 支持拼图、重置分支）。

### 验收

`npx tsc --noEmit` 干净；`npx vitest run` **270/270**（新增：`unitScale` × 3、唯一层级省级单位 × 3、大洋洲 × 2、拼图提交资格 × 4、服务端拼图校验 × 2、`isBetter` 拼图 × 1）；`verify-puzzle.mjs` **65/65**（含 1x 与地图实测比对、困难档零提示、北京/香港不下钻、大洋洲无次区域行、结算门槛、提交门控、完成卡片按钮）；`verify-round2` 38/38、`verify-round3` 38/38。

⚠ 需要**重新部署 Cloudflare Functions**，服务端白名单才会接受拼图成绩（`functions/_lib/validate.ts` 的 `MODES`）。`schema.sql` 无需迁移（`mode` 列没有 CHECK 约束），但注释已更新。

## 上一轮（拼图补齐世界/省级/市级）

需求（用户一次给了 7 条，前 6 条是上一轮的细节修正，第 7 条是本轮主体）：

1. 碎片上下覆盖改成**面积小的压在面积大的之上**（北京/天津陷在河北的环里）。
2. 去掉左下角那段解释文字。
3. 运行中**收起「简单/困难」分段按钮**（不允许中途切换），结束后重新显现。
4. 「重置」= **回到开始卡片界面**。
5. 难度分段按钮的**选中样式仿造其他模式**（其它分段按钮的 active 深色渐变 + 白字）。
6. 顶部「已拼」= **拼合进度**：起始 1，每发生一次吸附 +1，而不是"从卡槽拿出了几片"。
7. 加上**世界/省级/市级**三档分段按钮（世界支持全世界+下钻大洲/次区域，省级支持全国+下钻某省地级市，市级支持全国+下钻），并写好各范围的拼图逻辑。

用户追加的两条口径（问过才做）：**开始之前仍然显示完整地图**，方便下钻确定范围；**开始之后清空画布**；**单击空白 = 返回上一层**。

### 本轮真正的结构变化：拼图从"一阶段"变成"两阶段"

| | 选范围阶段（`puzzlePhase() === 'scope'`） | 拼图盘面（`'board'`） |
|---|---|---|
| 画面 | `#map` 可见（灰面 + 名称标签按难度） | `#map` 隐藏、`#puzzle` 显示（港澳放大框必须显式收起） |
| 按钮 | 粒度行 + 世界档的大洲行/次区域行 + 难度行 + 「重置」 | 「暂停」「重置」（难度行收起，结束后重现） |
| 地图交互 | 单击单位下钻、点空白退回上一层 | 无地图 |
| 出口 | 点「开始」→ 盘面 | 「重置」→ 选范围 |

- 三档**共用点击/输入模式的 scope 哨兵**，所以大洲行、次区域行、`isNationLikeScope` 等现成接线全部复用；`ModeController` 新增可选 `puzzlePhase?()`，`chromeSync` 用它决定地图/画布/粒度行/进度行/缩放角标的显隐。
- 片数：省级全国 **34**、世界 **194**（→亚洲 48、东亚 5…）、市级全国 **340**（→河北 11、四川 21…）。副标题与分母都由 `countScopePieces()` 现算（只数不解析几何）。
- 三个范围各自的获胜都已在真机验收里跑通（34/194/11 片自动解 → 一整块）。

### 本轮踩到并修掉的四个真 bug

1. **次区域哨兵里不含大洲**：选中东亚后 `continentFromScope('__subregion_EAS__')` 返回 null，于是洲行掉高亮、`setWorldMode(true, null, 'EAS')` 被渲染器当成"没有大洲"而**忽略次区域**（地图退回全世界、`hasDrillLevel()` 变 false、**点空白也返回不了**）。修法：模式的 `getWorldContinent()` 在次区域档用 `subregions` 元数据反查大洲（`setWorldSubregion()` 同样）。
2. **邻接图不连通 → 世界档拼不完**：兜底只给孤立片一条边，实测世界档分成 **6 块**（澳洲—巴新、新西兰、马达加斯加、日本…），`autoSolve` 只能拼到 6 组。`buildPuzzleAdjacency()` 新增**连通性修补**（按跨块 bbox 最小间距逐次搭桥）；单测对 9 个范围断言 `puzzleComponents(...).length === 1`。**这是"每局都有解"的硬保证，别删。**
3. **装饰面把答题池洗成 372**：`data.ts` 的 `isPureDecoration()` 只认南海诸岛，`{...u, decorative: false}` 把 2026-09 数据管线标的 32 个县级/兵团装饰面洗成了可答题单位（会出"仙桃市"、进度 372 格、拼图市级 372 片）。改成**数据标注优先**，加 `src/data.test.ts` 守住 33 装饰 / 340 答题。**这会同时影响点击/输入/无尽模式的出题池**（这是修正到文档口径，不是新特性）。
4. **量尺寸必须在显示之后**：`#puzzle` 在选范围阶段是 `display:none`，`getBoundingClientRect()` 宽度为 0 时算出的基比例与居中会把碎片摆到视口外。`showBoard()` 固定顺序：先让外壳切类名 → 再量尺寸/定视角。

### 新增/改动文件

- `src/puzzle/projection.ts`：加 `PuzzleFamily = 'china' | 'world'` 与两套 bbox（`spanLng/spanLat`），全部换算函数带可选 `family`（缺省 `'china'`，老调用点不用改）。
- `src/puzzle/pieces.ts`：`PuzzleScope`（granularity + family + province/continent/subregion）、`familyOf()`、`buildCountryPieces`（世界，按大洲/次区域过滤）、`buildProvincePieces`、`buildCityPieces`（按省过滤）、`countScopePieces()`（只数不解析几何，与 `buildPieces().length` 逐档相等，有单测）。
- `src/puzzle/adjacency.ts`：`buildPuzzleAdjacency(pieces, neighboursOf)`（第二个参数从 Map 改成**取邻居的函数**，按范围给不同来源）+ 兜底 + **连通性修补** + `puzzleComponents()`。
- `src/puzzle/view.ts`：`family: () => PuzzleFamily` 选项（所有投影调用带族）；`resetView()` 用 `spanLng(this.family)`；`fitAll(..., { includeSeaIslets, minZoom })`；`applyHint` 的 class 缓存。
- `src/modes/puzzle.ts`：**重写**为两阶段模式（粒度持久化 `china-admin-mode-granularity:puzzle`、下钻、`onBackToNation`、`showBoard()` 的顺序约定、`puzzlePhase()`、范围副标题、各范围邻居来源、`renderStatus` 在盘面阶段常显）。
- `src/ui/chromeSync.ts`：地图/画布按**阶段**显隐、粒度行只在选范围阶段、世界档洲/次区域行对拼图开放、难度行按"运行中"显隐、盘面阶段收起缩放角标、`provinceInset` 含拼图的省级全国选范围阶段。
- `src/modes/types.ts`：`ModeController.puzzlePhase?()`。
- `src/data.ts` + `src/data.test.ts`：装饰面判定改为数据标注优先（bug 3）。
- `src/probe.ts`：新增 `puzzleSetScope/puzzleBack`，`puzzle()` 快照加 `phase`。
- `scripts/verify-puzzle.mjs`：**重写为 47 项**（两阶段 × 三粒度：选范围/下钻/空白返回/开始清空/拖拽/磁吸/难度收起与重现/暂停/三种获胜/重置）。
- 文档：`DESIGN.md` §17（重写 + 新增 17.1/17.4）、`CONTEXT.md`（拼图范围、拼图邻接三层、难度两阶段作用）、`README.md`、`docs/shots/puzzle-*.png`。

验收：`npx tsc --noEmit` 干净；`npx vitest run` 255 例全绿（拼图 32 例含 9 个范围的连通性）；`verify-puzzle` 47/47、`verify-round2` 38/38、`verify-round3` 38/38。

## 上一轮（拼图模式首次落地）

需求：在输入模式右边、无尽闯关左边加一个**拼图模式**；进入时没有地图；左侧三个玻璃态方槽装着地图单位；拖出即 1:1 大小、可任意摆放；相邻两片接近时吸合成组、整组可拖；岛类（台湾/海南）以最近单位当邻居；碎片取 plus（40%）档；34 片拼成一整块即获胜。

四轮 grill 定稿的口径（详见 `DESIGN.md` §17 与 `CONTEXT.md` 的「拼图模式 / 卡槽 / 拼图组 / 拼图范围 / 拼图邻接 / 拼图难度」）：

- **入口**：mode id 新增 `puzzle`（按 ADR-0001 分配新 id）；页签顺序 点击/输入/**拼图**/无尽/自由；不提交排行榜（服务端白名单仍是 self/click/endless）。
- **画面**：**本轮起先选范围再拼图**——选范围阶段显示地图，点「开始」后 `#map` 隐藏、`#puzzle` SVG 画布显示（与留言板/管理同一套做法）；投影与地图页一致（分中国/世界两族）；默认比例 = 当前范围 bbox 宽 ≈ 视口宽 ×1.15；滚轮 0.6–6x、拖空白平移、双击空白复位。
- **卡槽**：左侧浮层竖排 3 个 96×96 玻璃态方槽、竖直居中；预览按最长边占槽 78%；随拖随补；开局时卡槽已填满（「开始」只切阶段并启动计时，不重新打乱）；不能退回卡槽。
- **磁吸**：只在**松手**时判定，容差 15 拼图像素（真实比例），对齐到**被拖动的一方**；拖动中只高亮"可吸附"；可连锁合并；不相邻的两片即使重叠也不吸。
- **海南与南海**：海南片只含主岛 + 近岸小岛；三沙等远海岛礁在**获胜后自动补上**（淡入并入海南组）；「南海诸岛」装饰面全程不出现。
- **难度**：简单/困难**只影响是否显示名称**（本轮起：选范围阶段作用于地图标签、拼图阶段作用于碎片与卡槽名称），默认简单、存 localStorage；运行中收起、不允许切换。
- **计时/暂停/获胜**：点「开始」才计时；暂停与切走都不累计；**不计步数**；当前范围全部碎片吸成一整块 → 补三沙（省级档）→ 镜头连带岛礁缩到整图 → 完成卡片（用时 + 再来一局/关闭）。

新增/改动文件：

- `src/puzzle/{projection,pieces,adjacency,state,view}.ts`（新）+ 对应 3 个单测文件（25 例）
- `src/modes/puzzle.ts`（新，模式：生命周期/计时/难度/获胜/探针钩子）
- `src/map/geometry.ts`：新增 `bboxOfPolygons`（按子集算海南主岛 bbox 用）
- `src/types.ts`（Mode 加 `puzzle`）、`src/ui/dom.ts`（`puzzleStatus`、`showSummary` 支持自定义「再来一局」文案）、`src/modeSettings.ts`（难度持久化）、`src/ui/chromeSync.ts`（`#puzzle`/`#map` 显隐、进度行、粒度/难度行、暂停与重置按钮分支）、`src/appController.ts`（注册模式、帮助文案、难度接线、切模式时不 resize 隐藏画布）、`index.html`（页签 + `#puzzle` + `#puzzle-status` + 难度分段按钮）、`messages.json`、`src/styles.css`
- `src/probe.ts`：新增 `puzzle/puzzleStart/puzzleAutoSolve/puzzleDifficulty/puzzlePlaceAt/puzzleTruePosition`
- `scripts/verify-puzzle.mjs`（新，22 项，含 CDP 真实鼠标拖拽；本轮已重写为 47 项）
- `docs/adr/0006-puzzle-uses-own-svg-canvas.md`（新）、`DESIGN.md` §17、`CONTEXT.md`、`README.md`

⚠ 实现中踩过的两个坑（都已修）：`pause()` 里必须**先 `commitElapsed()` 再置暂停标志**，否则整段时间被丢弃；获胜取景必须**连带 seaIslets 一起装进视口**，否则"自动补上"用户看不见。探针的 `puzzlePlaceAt` 走 `state.takeAny()`（能取池里的片），游戏内的拖拽仍只能从卡槽取。

## 拼图模式的两处线上修正（用户反馈）

1. **碎片被上下压扁**：`projection.ts` 把 ECharts 的 `aspectScale = 0.75` 用反了——它是**布局宽高比系数**，正确关系是"每度纬度像素 = 每度经度像素 / 0.75"（≈1.333 倍），第一版写成 `× 0.75`，于是碎片相对地图页被压扁 1.78 倍。修正后与地图页实测一致（地图页 `perPxY/perPxX` 恒为 0.7500）；`pieces.test.ts` 用 `px_w/px_h = (deg_w/deg_h) × 0.75` 钉住不变量。
2. **可吸附提示不够显眼 / 点选路径没有提示**：原提示只是目标组一条 2px 绿描边，困难模式下全是同色灰面又没有省名，几乎看不出来；且**点选→点放**的幽灵预览**完全没有提示**。现在：目标组 = 2.5px 绿描边 + 绿色辉光 + 半透明绿填充，手里那块同时加绿边；拖动与幽灵预览共用 `PuzzleState.candidatesFor()`（新增，只读）。验收脚本新增两条（两种难度各一条，都在**松手前**断言，并趁提示亮着截图 `puzzle-3b/3c-*`）。

## 上一轮（跟随钳制）：边缘目标不再被顶到正中

需求：世界跟随与省级/市级自动跟随，在目标已贴近当前地图范围边缘时不要把它挪到视觉正中，以免半屏空白。

已定口径（三轮 grill 收敛）：
- **取景边界**分层：全国=中国 bbox、**下钻省=该省几何 bbox**（邻省透明）、世界全国=世界 bbox、世界大洲/次区域=标定框。
- **中心钳制**（逐轴）：`center = clamp( clamp(t, min+hw, max−hw), t±(hw−m) )`；冲突时**外层让步**（优先保证目标不贴屏幕边），露白 ≤ m。
- **倍率下限**：`zoom = clampZoom(max(梯子倍率, 覆盖视口所需倍率))`；只有下钻小省真正生效（宁夏 12x → 28x 上限）。
- **答错跟随**：目标已舒适可见（视口内且距四边 ≥ m）→ 完全不动。
- **边距 m = 视口短边的 10%**（`FOLLOW_MARGIN_RATIO`），同时是"允许偏离上限/容忍露白上限/已可见判定阈值"。
- 即时取景（下钻省、切大洲/次区域）**不改**。

## 上一轮（UI 收尾）完成的六条需求

1. **熟练度分析左下角新增「设置」**：与其他模式同一套浮层（`#btn-mode-settings` → `#mode-settings-panel`），内含「隐藏地图标签」。
2. **熟练度分析阶梯改为 -10 / -5 / -1 / 0 / +1 / +5 / +10**：七档区间随之变为 糟糕≤-10、较差 -9~-5、陌生 -4~-1、一般 0、初识 +1~+4、熟练 +5~+9、炉火纯青≥+10。
3. **自由模式沿用「世界/省级/市级」分段按钮，但不支持下钻**。
4. **全局设置新增「世界边界」深浅**（与地级市边界、省级边界并列三档灰）。
5. **黑夜/白天模式按钮移到顶栏「设置」左侧**，文案显示点击后会切到的模式，立即持久化；设置面板里的黑夜模式开关已移除。
6. **按钮样式回滚 + 只改设置开关**（用户口径修正，见下）。

## 用户口径修正（第二轮追问后确认）

- **「按钮样式修改」= 回滚**：上一轮把全站按钮改成 DSH 胶囊是过度解读，用户要求全部回滚。`src/styles.css` 已用 `git checkout` 还原到胶囊化之前的版本，只在其末尾追加了两小段：DSH 开关样式 + 设置行对齐。**不要再给按钮加胶囊/自造样式。**
- **用户真正要改的是设置界面里那个（原本绿色的）开关**：已按 DeepSeek Harness 设置页的开关（`ui-settings-plugins` 的 `SubagentModelSelectionCard`）重做 —— 轨道 36×20、圆角 10、内边距 2px、圆形滑块 16px，打开时滑块右移 16px。颜色用 `--dsw-alias-brand-primary`（暗 `#f9fafb` / 明 `#0f1115`），于是：
  - 暗主题：关闭 = 半透明轨道 + **左侧白点**；打开 = **全白**
  - 明主题：关闭 = 浅灰轨道 + **左侧黑点**；打开 = **全黑**
- **自由模式与熟练度分析的三档地图默认显示地图标签**：新增 `RenderState.worldLabelZoomThreshold`（默认 2.2），这两个模式的地级/市级档传 `labelZoomThreshold: 0`、世界档传 `worldLabelZoomThreshold: 0`，即**任何倍率（含默认 1.00x 全景）都画标签**。原先地级档阈值是 4（自由模式是 1，而默认 zoom 恰好等于 1 → `zoom > 1` 为假），世界档 2.2，所以默认视图下**一个标签都不显示**，这正是用户反馈的问题。

## 关键文件与实现位置（跟随钳制）

- `src/map/renderer.ts`
  - `framingExtent()` 取景边界、`viewportWindow()` 视口数据矩形（画布两角 `pointToData`，**无窗口尺寸模型假设**）、`clampFollowCenter()` 中心钳制、`followZoomFloor()` 倍率下限、`isComfortablyVisible()` / `isNegligibleMove()` / `panFollow()`。
  - 纯函数 `clampFollowAxis()`（导出，供单测）与 `FOLLOW_MARGIN_RATIO`（导出，供探针复用）。
  - `viewProvinceBox` 字段：`drillToProvince` 里存下钻省的几何 bbox，**所有把 `viewProvince` 置 null 的地方都要一起清掉**（现有 6 处）。
- `src/map/followClamp.test.ts`（新，7 例）：钳制数学、露白 ≤ m、边界外目标仍在视口内、退化为边界中心。
- `src/probe.ts`
  - `worldAutoFollow()` 断言改写：从"误差 <1.5° 必然居中"改成"目标仍在视口内 + 内容不越出取景边界（边距之内）"，并返回 `sgpDetail/rusDetail/chnDetail` 原始数字。**注意越界量的符号**：west/south 是 `extent − window`，east/north 是 `window − extent`（第一版写反过，导致误报）。
  - `panOnWrong()` 增加 `ausVisible` 与 `stayedStill`（已舒适可见则不动）。
  - 新增截图用只读助手：`followShot` / `followUnitShot` / `flashTarget` / `followFrames`。
- `scripts/shot-follow-clamp.mjs`（新）：9 张边界/对照截图 + 每张打印取景边界/视口/中心/越界量。
- `scripts/verify-round2.mjs`：第 5、6 节的两条集成断言按新语义改写（现 38/38 通过）。

## 上一轮（UI 收尾）关键文件与实现位置

- `src/modes/analysis.ts`
  - 新增导出常量 `SCORE_BREAKPOINTS = [-10,-5,-1,0,1,5,10]`，`scoreColor()` / `provinceLevelOf()` 按它重写（地级/省级/世界三档共用）。
  - 新增 `getModeSettings()`（键 `hide-labels`，文案 `settings.hideMapLabels`）与 `hideLabels` 字段；`refresh()` 把 `hideLabels` 传给渲染状态，并据此关闭三档标签。
- `src/modeSettings.ts`：新增 `loadAnalysisHideLabels()` / `saveAnalysisHideLabels()`（键 `china-admin-analysis-hide-labels-v1`）。
- `src/types.ts`
  - `RenderState.hideLabels?`：渲染侧统一的「隐藏全部地名标签」开关（优先于 `showAllLabels` / `showAllProvinceLabels` / `worldShowAllLabels`）。
  - `Settings.worldBoundaryTone`。
- `src/styles.css`
  - **文件末尾新增两段**（其余部分是胶囊化之前的原样，用 `git checkout HEAD~1 -- src/styles.css` 还原过）：
    1. 「DSH 开关」：`--dsw-alias-brand-primary` / `--dsw-alias-label-primary-foreground` / `--dsw-alias-border-l3` 三个令牌 + `.card input[type="checkbox"]` 的 DSH 开关样式（36×20 / 圆角 10 / 16px 圆形滑块 / 选中 translateX(16px)）。
    2. 「设置行」：`.card .row { justify-content: space-between }` + `.row-label { flex:1; text-align:left }`，实现文字左对齐、控件右对齐。
  - 注意：开关样式是 `.card input[type="checkbox"]`，全局设置面板与每模式设置浮层（都是 `.card`）共用，改一处两处同时变。
- `src/map/renderer.ts`
  - `worldBoundaryTone` 字段；`setBoundaryTones(city, province, world)` 三个参数（第三个有默认值，旧调用不会炸）；`buildWorldRegionData()` 不再硬编码 `theme.boundary.mid`。
  - 三处标签数据构造（`buildLabelData` / `buildProvinceLabelData` / `buildWorldLabelData`）与 `desiredLabelMode()` 都加了 `hideLabels` 短路；世界档标签阈值改读 `state.worldLabelZoomThreshold ?? WORLD_LABEL_ZOOM`。
- `src/modes/freeBrowse.ts`：重写为支持粒度（`getGranularity()` / `setGranularity()`，键 `china-admin-mode-granularity:memory`，默认 `city`），三档分别走世界/省级/地级地图；`onUnitDblClick` 改为空实现（不下钻）。
- `src/modes/types.ts`：`ModeController.setGranularity?()` 可选方法补齐。
- `src/ui/chromeSync.ts`
  - `showsGranularity` 含 `memory`，且自由模式不受「全国范围/未开始测试」限制；自由模式世界档**不**显示大洲/次区域行。
  - `#mode-actions` 对自由模式不再整体隐藏。
- `src/appController.ts`
  - `toggleTheme()` / `syncThemeButton()`（顶栏 `#btn-theme`，`aria-pressed` 同步）。
  - 粒度按钮点击改为按当前模式派发（`this.current?.setGranularity`），修掉了原来对任何非 self 模式都回落到 clickMode 的老毛病。
  - 两处 `setBoundaryTones(...)` 与设置面板 `onSave` 都带上世界边界。
- `index.html`：顶栏新增 `#btn-theme`（在 `#btn-settings` 左侧）；设置面板移除黑夜模式开关、新增 `#set-world-boundary-tone`；所有设置行改为 `<span class="row-label">文字</span> + 控件`。
- `src/ui/settingsPanel.ts`：读写世界边界，保存时保留 `current.darkMode`（该字段已不由面板管理）。
- `src/ui/modeSettingsPanel.ts`：开关行改为文字左、开关右。
- `messages.json`：新增 `settings.hideMapLabels`、`topbar.themeDark`、`topbar.themeLight`；更新 `help.free.body`（写明分界线）与 `help.memory.body`（不再下钻）。

## 新增测试与验收脚本

- `src/modes/analysis.test.ts`：按新断点重写（含 `SCORE_BREAKPOINTS` 断言）。
- `src/modes/freeBrowse.test.ts`（新）：用假渲染器锁住「默认市级 / 三档切换 / 双击不下钻 / 隐藏标签透传 / 标签阈值 0」。
- `scripts/verify-round3.mjs`（新）：真实无头 Edge 跑 38 条断言——主题按钮位置与切换、**按钮已回滚**（圆角 ≤10px、主按钮绿色、分段选中项渐变）、**开关样式**（36×20 几何 + 明暗两套黑白关系）、设置行左右对齐、世界边界生效、分析左下角设置与隐藏标签、自由模式三档与下钻能力位、**三档地图默认画标签**（直接数渲染器实际生成的标签数量：地级 373 / 省级 34 / 世界 194）、以及对比度/裁切/重叠的客观体检；输出 `docs/shots/round3-1..11-*.png` 供目测。
- `src/probe.ts`：新增只读探针 `round3Ui()`（主题/边界/渲染标签开关与阈值/自由度粒度与能力位/各标签系列的实际标签数 `labelCounts`），供验收脚本断言。`labelCounts` 通过 `fn.call(renderer, state)` 调用渲染器的私有构造器，**必须带 receiver**，否则内部读 `this.worldMode` 会抛错。

## 注意事项

- **不要改按钮样式**：用户明确要求回滚胶囊化。新增按钮沿用现有样式（8px 圆角 + 1px 描边 / 绿色 primary / 深色渐变选中项），详见 `DESIGN.md` §15。
- 设置界面里的开关样式只有一处定义（`.card input[type="checkbox"]`），全局设置面板与每模式设置浮层共用；要改颜色只动 `--dsw-alias-brand-primary`（以及 `body.theme-dark` 里的反相值）。
- `Settings.darkMode` 仍存在且被 `loadSettings/saveSettings` 管理，只是不再由设置面板写入——任何新的「保存设置」入口都要像 `openSettings` 一样带上 `darkMode: current.darkMode`，否则会把主题重置。
- 自由模式与熟练度分析的世界档国名标签**默认常显**（`worldLabelZoomThreshold: 0`）；其余模式仍用渲染器默认 `WORLD_LABEL_ZOOM(=2.2)`。想改回按缩放显示，只需去掉这两个模式传入的 0。
- `AnalysisMode` 的省级档与地级档之间仍有「双击省 → 看该省地级熟练度 → 返回恢复省级档」的历史行为（`returnToProvince`），本轮未动。
- 侧栏「全国概览/世界概览」那一行七档计数在窄栏下会把最后一个数值挤到下一行——这是**本轮之前就有**的排版问题，未处理。

## 建议验证

1. `npm test`（193 条用例）与 `npm run build`（tsc + vite 均须通过）。
2. `node scripts/verify-round3.mjs`：应输出 `38/38 通过`，并刷新 `docs/shots/round3-*.png`。
3. 手工：点击顶栏「设置」左侧按钮切主题；打开设置看开关的两种状态（暗=关左白点/开全白，明=相反）；改「世界边界」看世界图国家边界变化；进熟练度分析点左下「设置」开关「隐藏地图标签」，并确认地级/省级/世界三档默认都显示标签；进自由模式点「世界/省级/市级」并双击任意面确认不下钻。
