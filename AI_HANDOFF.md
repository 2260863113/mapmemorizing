# 给下一个 AI 的交接文档

## 本轮（UI 收尾）完成的六条需求

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

## 关键文件与实现位置

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
