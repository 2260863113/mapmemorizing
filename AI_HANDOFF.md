# 给下一个 AI 的交接文档

## 当前仓库状态

本轮是在用户要求“推送代码后继续改动”的基础上继续做 UI 和设置改动。第一轮已经完成并保留在仓库中：

- 输入模式、挑战模式、点击模式各自独立记住测试范围（全国或省份），切换/暂停/恢复不会互相覆盖。
- 自动跟随按目标所在省份调整缩放：新疆、青海、西藏、内蒙古为 6x，海南为 28x，其它为 12x，并沿用平滑动画。

本轮继续完成了：

- 设置面板新增“个性化”分组，可分别配置地级市边界、省级边界线条深度：浅灰色、灰色、深灰色。
- 顶部计时器/倒计时移动到顶部中心；点击模式运行中，出题地名卡片在顶部中心，秒表显示在卡片右侧。
- “中断”按钮和帮助说明改为“暂停”。
- 暂停时只模糊地图和侧栏内容，顶部按钮、搜索框、题卡、计时器、底部说明/缩放控件保持清晰。

## 关键文件

- `index.html`
  - `#btn-end` 文案已改为“暂停”。
  - 新增 `#top-status`，内部包含 `#top-hint` 和 `#test-timer`。
  - 普通说明仍使用 `#mode-hint`，与顶部题卡分离。
  - 设置面板新增“测试 / 个性化”分组和两个边界深度下拉框：`#set-city-boundary-tone`、`#set-province-boundary-tone`。

- `src/types.ts`
  - 新增 `BoundaryTone = 'light' | 'mid' | 'dark'`。
  - `Settings` 新增 `cityBoundaryTone` 和 `provinceBoundaryTone`。

- `src/store.ts`
  - `DEFAULT_SETTINGS` 默认保持原视觉：地级市边界 `light`，省级边界 `dark`。
  - `loadSettings()` 会归一化旧 localStorage 中的边界设置，避免异常值传给渲染层。

- `src/ui/settingsPanel.ts`
  - 打开设置时读取两个边界深度下拉框。
  - 保存时把两个下拉值写入 `Settings` 并持久化。

- `src/map/renderer.ts`
  - `MapTheme` 中的硬编码 `border` / `provinceBorder` 改为 `boundary: Record<BoundaryTone, string>`。
  - 新增 `setBoundaryTones(cityBoundaryTone, provinceBoundaryTone)`，保存设置后会重绘地图。
  - 地级边界使用 `theme.boundary[this.cityBoundaryTone]`。
  - 省级 lines 使用 `theme.boundary[this.provinceBoundaryTone]`。

- `src/ui/dom.ts`
  - `setHint()` 会把包含 `start-panel` 的顶部卡片写入 `#top-hint`，普通说明写入 `#mode-hint`。
  - `showTimer()` / `showStopwatch()` 继续复用 `#test-timer`，但节点已移动到顶部状态区。

- `src/styles.css`
  - 新增/调整 `#top-status`、`#top-hint`、`#mode-hint` 布局。
  - 清理了旧 `#timer-pill` 引用。
  - 暂停模糊规则只作用于 `#map` 和 `#side-panel`。
  - 设置面板内 `select` 使用卡片表单样式，避免继承顶栏按钮风格。

## 注意事项

- `src/modes/selfTest.ts` 内部类名和部分字段仍叫 `SelfTestMode` / `selfTimerEnabled`，这是历史代码名；用户可见文案已尽量改为“输入模式”。如果继续重命名内部 API，注意会影响多个模式和设置字段。
- `Settings.followZoom` 仍保留在设置里，但 `MapRenderer.focusUnit()` 现在按省份固定 6/12/28 档，入参 `_zoom` 已不再使用。这是第一轮需求导致的兼容保留。
- 暂停恢复目前通过点击 `#pause-overlay` 完成；遮罩覆盖全主区用于接收点击，但视觉模糊只在地图/侧栏上。

## 建议验证

1. 运行 `npm run build` 确认 TypeScript 和 Vite 构建通过。
2. 手工打开设置：确认“个性化”里两个边界下拉框保存后地图边界立即变化。
3. 进入挑战模式：倒计时应在顶部中心。
4. 进入点击模式并开始：地名卡片应在顶部中心，秒表在卡片右侧。
5. 暂停测试：地图应模糊，按钮、搜索框、题卡、计时器不应被模糊。点击空白遮罩应恢复测试。
