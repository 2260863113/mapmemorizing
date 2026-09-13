# 拼图模式自带 SVG 画布，不复用 ECharts 地图

新增的**拼图模式**（mode id `puzzle`）需要"每个省级单位是一个可独立平移的碎片、相邻两片靠近时吸合、成组后整组一起拖"。这个需求与本项目其余模式（都在同一张 ECharts `geo` 上着色/命中）在底层能力上不匹配：

1. **ECharts 的 geo 只能整体平移/缩放**——`geo.center`/`geo.zoom` 是相机，`regions` 里的单个 region 没有自己的 transform 通道，无法让 34 个省各自位于不同位置；
2. **全仓没有任何拖拽基建**——`graphic` 组件、`draggable`、custom series 的 `graphic: true` 都是零使用，唯一一次碰 zrender 只是用 `getZr().on('click')` 判"点空白"；要在这里长出"每片可拖 + 成组 + 命中 + 磁吸"等于自己写一套，却还要绕过 ECharts 的布局与 5 档换图机制；
3. **拼图不需要地图的其它能力**——没有底图、没有 tooltip、没有缩放档位切换、没有港澳放大框、没有裁剪；反而是一块"什么都没有"的画布。

因此拼图模式用一块自带的 **`#puzzle` + SVG 画布**（与 `#board`/`#admin` 同一套"隐藏 `#map`、显示自己"的做法），碎片是 `<path>`（几何取自省级 plus 40% 档），位置由所属 `<g class="puzzle-group">` 的 `translate(dx,dy)` 决定，拖拽/命中/磁吸都由自己的 pointer 事件与 `PuzzleState` 处理。**投影必须与地图页一致**（同一份 `MAP_PROJECTION_BBOX.china` + ECharts 对 GeoJSON 源的默认 `aspectScale = 0.75`），否则拼出来的形状与地图页对不上。

**Status**: accepted

**Consequences**:

- 拼图与地图渲染器**完全解耦**：拼图模式只借用渲染器一次——`setProvinceMode(false, { inset: false })` 把港澳放大框收起来（它由渲染器驱动，不随 `#map` 一起隐藏）。渲染器的五档换图、裁剪、标签体系一概不参与。
- 拼图模式下 `#map` 隐藏，因此**不要**在切模式时调用 `renderer.resize()`（对隐藏容器 resize 会把画布算成 0 尺寸），`appController.switchMode` 里对此有显式分支。
- 碎片的位置模型是"真值几何 + 组偏移"：`<path>` 的 `d` 永远是真值投影，用户拖动只改组偏移，于是"两片摆对了"= 两组偏移相等 —— 磁吸就是"把另一组的偏移改成被拖动那一组的值"。这条模型是 `src/puzzle/state.ts` 与 `view.ts` 的共同前提，改动时两边要一起动。
- 由此新增的纯逻辑都在 `src/puzzle/`（投影 / 切片 / 邻接 / 状态机），有单测；`scripts/verify-puzzle.mjs` 用真实鼠标事件（CDP `Input.dispatchMouseEvent`）验收拖拽。
- 将来若要做"世界档 / 地级档拼图"，只需换 `buildPieces` 的数据源与邻接表——画布与状态机不需要改（粒度分段按钮已经预留三档，当前非省级只提示"暂未开放"）。
