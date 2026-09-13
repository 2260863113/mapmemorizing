# 给下一个 AI 的交接文档

## 本轮（UI 收尾）完成的六条需求

1. **熟练度分析左下角新增「设置」**：与其他模式同一套浮层（`#btn-mode-settings` → `#mode-settings-panel`），内含「隐藏地图标签」。
2. **熟练度分析阶梯改为 -10 / -5 / -1 / 0 / +1 / +5 / +10**：七档区间随之变为 糟糕≤-10、较差 -9~-5、陌生 -4~-1、一般 0、初识 +1~+4、熟练 +5~+9、炉火纯青≥+10。
3. **自由模式沿用「世界/省级/市级」分段按钮，但不支持下钻**。
4. **全局设置新增「世界边界」深浅**（与地级市边界、省级边界并列三档灰）。
5. **黑夜/白天模式按钮移到顶栏「设置」左侧**，文案显示点击后会切到的模式，立即持久化；设置面板里的黑夜模式开关已移除。
6. **按钮统一为 DSH 胶囊风格**，设置行改为「文字左对齐、控件右对齐」。

## 关键文件与实现位置

- `src/modes/analysis.ts`
  - 新增导出常量 `SCORE_BREAKPOINTS = [-10,-5,-1,0,1,5,10]`，`scoreColor()` / `provinceLevelOf()` 按它重写（地级/省级/世界三档共用）。
  - 新增 `getModeSettings()`（键 `hide-labels`，文案 `settings.hideMapLabels`）与 `hideLabels` 字段；`refresh()` 把 `hideLabels` 传给渲染状态，并据此关闭三档标签。
- `src/modeSettings.ts`：新增 `loadAnalysisHideLabels()` / `saveAnalysisHideLabels()`（键 `china-admin-analysis-hide-labels-v1`）。
- `src/types.ts`
  - `RenderState.hideLabels?`：渲染侧统一的「隐藏全部地名标签」开关（优先于 `showAllLabels` / `showAllProvinceLabels` / `worldShowAllLabels`）。
  - `Settings.worldBoundaryTone`。
- `src/map/renderer.ts`
  - `worldBoundaryTone` 字段；`setBoundaryTones(city, province, world)` 三个参数（第三个有默认值，旧调用不会炸）；`buildWorldRegionData()` 不再硬编码 `theme.boundary.mid`。
  - 三处标签数据构造（`buildLabelData` / `buildProvinceLabelData` / `buildWorldLabelData`）与 `desiredLabelMode()` 都加了 `hideLabels` 短路。
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
- `src/styles.css`：文件末尾新增整段「DSH 按钮风格」（`--dsw-alias-*` 令牌 + 各类按钮的胶囊规则 + 设置行对齐），并覆盖了 `#mode-tabs` / `.top-actions` / `.mode-action` / `.mode-segmented` / `button.primary|ghost` / `select` 等既有规则。

## 新增测试与验收脚本

- `src/modes/analysis.test.ts`：按新断点重写（含 `SCORE_BREAKPOINTS` 断言）。
- `src/modes/freeBrowse.test.ts`（新）：用假渲染器锁住「默认市级 / 三档切换 / 双击不下钻 / 隐藏标签透传」。
- `scripts/verify-round3.mjs`（新）：真实无头 Edge 跑 31 条断言——主题按钮位置与切换、胶囊几何（圆角=高/2）、设置行左右对齐、世界边界生效、分析左下角设置与隐藏标签、自由模式三档与下钻能力位、按钮对比度/裁切/重叠的客观体检，并输出 `docs/shots/round3-1..11-*.png` 供目测。
- `src/probe.ts`：新增只读探针 `round3Ui()`（主题/边界/渲染标签开关/自由度粒度与能力位），供验收脚本断言。

## 注意事项

- **按钮风格只有一种**：新增按钮请复用 `styles.css` 末尾的档位与变体，不要再引入渐变/粗描边/方角（详见 `DESIGN.md` §15）。
- 顶栏是常暗表面（明主题下也深色），其胶囊用 `.topbar` 上的 `--topbar-pill-*`，不要用明主题的 `--dsw-alias-*` 浅色值。
- `Settings.darkMode` 仍存在且被 `loadSettings/saveSettings` 管理，只是不再由设置面板写入——任何新的「保存设置」入口都要像 `openSettings` 一样带上 `darkMode: current.darkMode`，否则会把主题重置。
- 自由模式世界档的国名标签仍在 `WORLD_LABEL_ZOOM(=2.2)` 之后才显示（世界图 zoom 1 时 194 个国名会严重重叠），与熟练度分析世界档行为一致；如需常显，要在 renderer 里另加开关而不是直接去掉阈值。
- `AnalysisMode` 的省级档与地级档之间仍有「双击省 → 看该省地级熟练度 → 返回恢复省级档」的历史行为（`returnToProvince`），本轮未动。
- 侧栏「全国概览/世界概览」那一行七档计数在窄栏下会把最后一个数值挤到下一行——这是**本轮之前就有**的排版问题，未处理。

## 建议验证

1. `npm test`（188 → 193 条用例）与 `npm run build`（tsc + vite 均须通过）。
2. `node scripts/verify-round3.mjs`：应输出 `31/31 通过`，并刷新 `docs/shots/round3-*.png`。
3. 手工：点击顶栏「设置」左侧按钮切主题；打开设置改「世界边界」看世界图国家边界变化；进熟练度分析点左下「设置」开关「隐藏地图标签」；进自由模式点「世界/省级/市级」并双击任意面确认不下钻。
