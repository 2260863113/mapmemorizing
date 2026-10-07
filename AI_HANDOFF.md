# 给下一个 AI 的交接文档

## 本轮（2026-10 第四轮）：「其他」档三条用户反馈（撤小窗 / 修地图消失 / 标签口径）

用户三条（原话）：
1. 「去掉其他范围中四个国家的左下角小地图，用户直接点击大地图上的就可以了。」
2. 「修复一旦进入"其他"，回到省级和市级的时候地图就消失不见的bug。」
3. 「对于"其他"的四个国家，地图标签保持大小不变，始终为最大尺寸。」
追加一条（看到截图后）：「为什么这么多标签啊，没开始就不要显示标签啊。」

### 1. 撤掉左下角小窗 → 飞地回到主图

- **数据层**（`scripts/fetch-other-admin1.mjs`）：`insetGroups` 四个国家全部清空，
  `bbox.main` 改成**全部单位**的并集 → 美国主图含 −187.5°（阿留申）与 18.9°N（夏威夷）、
  俄罗斯含 19.6°~191°（加里宁格勒 + 楚科奇）。重新生成了 `public/data/other/*`。
- **代码层**：删掉 `src/map/otherInset.ts` 整块、`#other-insets` DOM 与 CSS、
  `#app[data-other-inset]` 的按钮让位规则、`registerOtherMaps` 的小窗地图注册、
  `OtherCountryData.insetGeoJsons/bboxInsets`、`OtherUnitMeta.inset/insetGroup`
  （`buildOtherRegionData` 里"飞地静默"与 `buildOtherEventData` 里 `!u.inset` 的过滤一并删掉）。
- `src/otherData.test.ts` 改成断言"数据里**没有** inset 标记" + "包围盒 = 全部单位并集"。

### 2. ⭐ 进过「其他」之后回省级/市级，地图消失（真 bug）

**根因**：`MapRenderer.snapshotViewBeforeLeave()` 只认 `world` 与"中国"两族，
`other-usa` 落到了中国分支里，于是**把美国的取景写进了中国族的记忆槽**；回省级时
`pickViewFor('china-…')` 读回那个槽 → 相机被"恢复"到美国中心 `[-95.86, 36.96]` → 中国地图整个落在
屏幕外 → **画布一片空白**。而 `appliedMapName` 是对的，所以**只看地图名的验收脚本抓不到**
（用户的描述是"地图消失不见"，我的脚本只断言了地图名 —— 这是这一轮最有价值的教训）。

**修法**：`snapshotViewBeforeLeave()` 里 `mapName.startsWith('other-')` 直接 return（这一族的取景
是"进哪国都从整国铺满开始"，没有跨族恢复的需求，也不该占中国族的槽）。

**验收补强**：`verify-other.mjs` 现在会读**画布像素直方图**（与左上角背景色不同的像素占比），
对"进其他 → 回省级 → 切市级"三步都断言 `fillPct > 3%` 且相机回到中国范围。只断言地图名的脚本
必须补上这一条，否则同类缺陷还会漏。

### 3. 标签字号恒为最大档

`provinceLikeLabelSeries('other-labels', …)` 的缩放闭包从 `() => labelScale(this.zoom)` 改成 `() => 1`
（与省级省名标签一致）。截图对比 1.00x 与 0.80x：标签逐像素同尺寸，地图背景才变小。

### 4. 未开始不显示地名标签（用户追加口径）

`MapQuizMode.browseLabelState()` 原来对「其他」档返回 `{ otherShowAllLabels: true }`（跟中国/世界
两档一样在未开始时铺满标签）→ 47/51 个一级行政区把地图糊成一片。改为**这一族默认不显示**：
不看 `settings.showBrowseLabels`（它默认开着、是为中国/世界两档设的），只在 `labelsOverride === true`
（按 Alt）时显示。

⚠ 连带修的一处：Alt 的基准值必须与"此刻真的看到什么"一致，否则「其他」档**第一次按 Alt 会毫无变化**
（它把状态翻成 false）。为此把判据收进模式并暴露给外壳：
`MapQuizMode.labelsVisible()`（`ModeController.labelsVisible?()`），`appController.handleLabelToggle`
优先问它。新增 `src/modes/browseLabels.test.ts` 三条用例守着（默认不显示 / Alt 显示 / 中国档不受影响）。

### 验收

- `npm run check` 退出 0：**61 文件 / 853 用例**、eslint 0 error / 1 条既有 warning。
- 八套浏览器验收全绿共 **411 项**：`verify-other` **41/41**（新增：无小窗容器、飞地在主图 events data 里、
  未开始零标签、Alt 显示/再按收起、**回省级/市级画布非空 + 相机回中国**），
  其余 round2 38 / round3 54 / naming 47 / drill-scope 34 / puzzle 84 / mobile-gate 24 / admin-traffic 89 → 无回归。
- 截图（`docs/shots/`）：`verify-other-1-usa.png`（美国含阿拉斯加/夏威夷一图）、
  `verify-other-5-back-province.png`（回省级正常）、`verify-other-7/8-labels-*.png`（1.00x vs 0.80x 字号相同）。

### ⚠ 留给下一个 AI（延续上一轮）

1. 日俄两档的"英文名"是罗马字（`Moskva` / `Gorno-Altay`），常见英文名要另加别名表。
2. 「外语」按钮文案仍是固定的「外语」（实际语言由国家决定），要跟着国家变得让 `label` 支持函数。
3. 加国家只需重跑数据管线 + 在 `COUNTRIES` 加一行。
4. 这一族**不进拼图模式与 SEO 落地页**（用户口径）。
5. 撤掉小窗的**代价**：美国主图被阿拉斯加/夏威夷撑宽，本土各州变小、标签在大陆部分更挤 ——
   若用户后续嫌挤，可考虑的方案是"默认视野只框本土 + 飞地靠平移看"（但那与"直接点大地图"有冲突，
   需先跟用户确认）。

## 本轮（2026-10 第三轮）：「其他」档 —— 输入/点击模式考他国一级行政区

用户需求（原话）：「对于输入模式和点击模式，在"世界/省级/市级"分段按钮右侧添加新的分段"其他"，
点进去之后，下方显示新的分段按钮"美国/加拿大/日本/俄罗斯"，上方分段按钮为"随机/错题"或者
"顺序/随机/错题"的分段按钮，以及"中文/外语"的分段按钮，用户的答题内容为这些国家的行政区划分
（对应中国的省级），可以通过分段按钮切换到当地语言（美国加拿大英语，日本日语，俄罗斯俄语）。」

用户追加确认的四条口径：争议地区**不考但显示**；**纯练习**（不计熟练度、不上排行榜）；
飞地放**左下角小窗**（与港澳小窗同一套）；本轮只做**输入 + 点击**两个模式。

设计取舍全部写在 **[ADR 0011](docs/adr/0011-other-admin1-scope.md)**（独立成第四族 / 不计分但记错题 /
不考但显示 / 飞地小窗 / 判题打分 / 按国家懒加载）与 CONTEXT.md 的**其他档**、**不考但显示**两个词条。
这里只记"下一个 AI 最容易踩的坑"与数据层的脏东西。

### 数据层（`scripts/fetch-other-admin1.mjs` → `public/data/other/*`）

Natural Earth 10m `admin_1_states_provinces`（与现有世界图同源同版本），四国 196 个面，
几何 567KB **按国家懒加载**。美国 51（50 州 + DC）/ 加拿大 13 / 日本 47 / 俄罗斯 85（题池 83 + 不考 2）。

⚠ **源数据比预想脏，实测到的每一条都已兜底**（改数据源或换版本时，`src/otherData.test.ts`
的 40 条断言会先报警）：

1. `RU-X01~`：属性**全空**（无名称/无 iso/无类型）的残留面 → 显式丢弃清单；
2. `RU-MOW`/`RU-MOS` 的**编码与几何是互换的** —— NE 把**州**的几何挂在 `MOW`（市的编码）上。
   第一版只改中文名，结果"大块州几何标着『莫斯科』、小块市标着『莫斯科州』"（靠包围盒
   对不上才发现）。**正确修法是交换编码**（编码是题目身份，名字只是显示）；
3. `RU-AL`/`RU-ALT` 中文重名（都是「阿尔泰共和国」）、`RU-KAM`/`RU-IRK` 繁体残留、
   `JP-13` 缺「都」→ `ZH_OVERRIDES`；
4. `RU-ARK` 的 `name_local` 错配成沃洛格达州、`RU-ALT` 的 `name_ru` 错配成阿尔泰共和国 ——
   **两个字段各错一条**，正确值都在**另一个字段**里，故没法"统一优先某个字段"，只能逐条钉；
5. **跨 180° 经线**（楚科奇、阿留申）必须**按国家**参考经度解缠：逐单位各算一次会让公共边界的
   浮点尾数不一致 → mapshaper 认不出同一条弧 → 拓扑丢失（实测孤立单位从 2 个暴涨到 33 个）；
6. 飞地清单是**显式**的（`insetGroups`），不能用连通分量启发式：日本四个大岛之间也没有陆地相邻。

### 接入层的四个真实缺陷（都由 `scripts/verify-other.mjs` 33 项抓出）

1. **换国家只重建题池、没告诉渲染器** → 切到日本后地图还是美国各州。修法：`setOtherCountry()`
   内部同步调 `syncScopeView()` + `refresh()`；
2. **切语言只重建题池** → 题面变日语而地图标签还是中文（标签由渲染器按 `LayerInput.otherLang` 现取）；
3. ⭐ **切到"没有飞地的国家"时只隐藏小窗容器、没释放旧 ECharts 实例** → 下一次 `render()`
   按**旧实例个数**去索引新国家的 `bboxInsets[i]`，`undefined[0]` 抛异常；异常从 ECharts 冒出来
   **打断整条 `afterScopeChange()`**，于是国家按钮高亮、语言行、占位提示**全部停在旧状态** ——
   一个渲染异常伪装成"点了没反应"。定位靠**控制台**（页面里的 try/catch 把它变成一条 toast）：
   `console.warn('other country load failed:', e)` 只给 message，把 `e.stack` 打成**字符串**才看到
   栈指向 ECharts 的 render；
4. 国家按钮的选中态被 `syncSegmentedToggle` 的取值链漏掉（要加 `btn.dataset.otherCountry`），
   手工设的 `.active` 会被紧随其后的统一同步重置。

### ⭐ 判题：不能只做"归一化后查表"

剥掉行政后缀后，源数据里有**两对**名字会撞成同一个键：`阿尔泰共和国`/`阿尔泰边疆区` 都剥成「阿尔泰」、
`莫斯科`/`莫斯科州` 都剥成「莫斯科」。**只做相等判断会把用户答对的「阿尔泰边疆区」判成阿尔泰共和国**
（不报错，表现为"我明明答对了却判错"）。发现者是 `src/other.test.ts` 里那条**真实数据全覆盖**用例：
把四国题池里每个单位的三种名字都拿去答一遍，看是否命中自己。

修法：`matchOtherUnit(input, units, preferred)` 按「精确（不剥后缀）> 归一化（剥后缀）> 前缀兜底」打分取最高，
并列时优先 `preferred`（输入模式传 `NamingJudgeCtx.question` = 当前题目），仍并列则取第一个（稳定可复现）。
前缀兜底要求输入 ≥2 字（否则「北」这种单字会乱命中）。

### 验收

- `npm run check` 退出 0：**61 文件 / 849 用例**、eslint 0 error / 1 条**既有** warning（`src/testCtx.ts`）。
- `npm run build` 通过；真实浏览器**八套**验收全绿共 **436 项**：新增 `verify-other` **33/33**，
  其余 round2 38 / round3 54 / naming 47 / drill-scope 34 / puzzle 84 / mobile-gate 24 / admin-traffic 89 → **无回归**。
- 新增单测：`src/other.test.ts`（26：归一化、三种写法、**四国题池全覆盖**、撞车两对的回归闸门、
  虚拟题池、本地记忆与隐私模式）+ `src/otherData.test.ts`（40：数据完整性）。
- 已部署：提交 `bad0024`（数据）+ `5b5c13b`（接入）+ 后续（判题打分与单测）推送到 GitHub main，
  Cloudflare Pages 自动部署；线上 `index-gml7R7l7.js` 与 `public/data/other/*`（含 187KB 的俄罗斯档）均已 200。

### ⚠ 留给下一个 AI

1. **日俄两档的"英文名"是罗马字**（莫斯科是 `Moskva` 而非 `Moscow`、阿尔泰共和国是 `Gorno-Altay`
   而非 `Altai Republic`）。要让常见英文名也算对，需要另加一张别名表（美加两档没有这个问题）。
2. 「外语」按钮文案目前是**固定的「外语」**（实际语言由上面的国家决定）。用户还没对这点表态；
   若改成跟着国家变（英文/日文/俄文），改 `src/modes/naming.ts` 的 `OTHER_CHOICES` 一处即可 ——
   但注意按钮文字现在是**静态** `label`，要变成动态得让 `label` 支持函数并在 `chromeSync` 里同步。
3. **加国家**（德国/印度…）只需重跑数据管线 + 在脚本的 `COUNTRIES` 里加一行：UI 的国家按钮由数据渲染，
   模式、渲染器、判题都不用改。
4. 这一档**不进拼图模式与 SEO 落地页**（用户口径：本轮只做输入 + 点击）。

## 本轮（2026-10 第二轮）：手机端访问门槛 + 答错扣三分

用户两条（原话）：

1. 去给手机端写一个门槛，当用户用手机访问时，在加载之前，窗口询问「请用电脑端访问」，下方添加按钮「继续访问」，如果用户点击继续访问，那么在手机端，用户在手机上看的内容是电脑视图显示，而不是 ui 错乱的手机视图。
2. 将熟练度分析中，答错一题扣三分，而不是现在的一分。答对只得一分。

### 1：手机端访问门槛（`index.html` 内联 + `src/mobileGate.ts` 契约）

**为什么内联在 `index.html`**：项目**没有**手机版布局（只有两处窄屏微调），所以门槛必须早于主 bundle（1.3MB）生效 —— 否则用户会先看到一眼错乱的手机布局（`styles.css` 在构建产物里是 `<link>`，首屏就生效而 JS 还没跑）。故遮罩的 `<style>` 与判定 `<script>` 都写在 `index.html` 的 `<head>` 里（同步执行、早于首次绘制）。**光靠 `main.ts` 做不到这一点**（那时首屏已经画过一次）。

**判据三条同时成立才弹**：UA 像手机（`PHONE_UA_SOURCE`）、确实有触屏或粗指针（`maxTouchPoints>0 || (pointer: coarse)`）、且**不是爬虫**（`CRAWLER_UA_SOURCE`）。第三条是因为 Googlebot-Smartphone 与普通手机 UA 无法区分，而本站 SEO 依赖爬虫读正文（README 的 SEO 一节）。

**"电脑视图"的实现是改 layout viewport**：手机上一律先把 `<meta name="viewport">` 改成 `width=1280`（`DESKTOP_VIEWPORT`）。选 1280 是因为项目自己的窄屏断点是 900 / 620px，1280 保证落在"电脑档"。**在首次绘制前就改**（而不是点按钮时才改）：iOS 对运行时改 viewport 不总是重排，而遮罩盖着时用户看不见底层布局，所以"提前改成桌面宽度 + 点按钮只去掉遮罩"是零风险的做法。门槛生效期间 `#app` 是 `visibility: hidden`（**不是 `display:none`** —— 后者会让 ECharts 量到 0×0 画布）；`AppController.onGlobalKeyDown` 在 `html.mobile-gate` 存在时直接早退，免得遮罩背后按 Tab 把测试重开。

**选择记在 `localStorage['china-admin-mobile-gate-v1'] = 'continue'`**，同一台手机下次访问不再打扰（仍按电脑视图）。

⚠ **口径分两处，靠单测消漂移**：内联脚本不能 import 模块或文案表，故 `src/mobileGate.ts` 持有正则源码/存储键/viewport/class 等常量，`messages.json` 持有两句文案，`src/mobileGate.test.ts` 断言 `index.html` **逐字包含**它们（与 `capabilities.test.ts` 断言 tab 文案同一套路）。**改门槛口径时三处一起改**，忘了会立刻红。

### 1b：手机端「按钮重复」的真实原因与修法（用户截图反馈后追加）

用户在**百度 App 内置浏览器**（Android，UA 里 `baiduboxapp` + `Chrome/97`）里看到：左上角叠了三个
「1.00x」和多余的「说明」，而左下角还有一套正常的控件 —— 看起来像控件被重复渲染。

排查结论（重要，别再走弯路）：
1. **不是 DOM 重复**。用用户的真实 UA 复现后 dump 过：`#zoom-pill` / `#btn-help` / `#settings` /
   `#hkmac-inset` 的 `count` 全是 **1**，源码里也各只有一个。
2. **是 compositor 残影**。根因在旧实现：`<head>` 里**先静态声明 `width=device-width`，再由内联脚本改成
   `width=1280`**。旧内核在脚本执行前就按 `device-width` 排版并合成了那几个带圆角/阴影的浮动控件图层；
   改成 1280 触发重排后**旧图层没有被失效**，于是旧位置（左上）留下残影、新位置（左下）是当前值。
   现代 Chromium 会正确失效 —— 所以本地、`verify-mobile-gate`（新版 Edge）**永远复现不出来**，
   只有真实旧内核才暴露。这也是"用户截图比自动化验收更有信息量"的一个实例。
3. **修法：全程只声明一次 viewport**。删掉静态 meta；内联脚本用 `document.createElement('meta')`
   在 `<head>` 最前面**创建**唯一的那一个（手机 `width=1280`、其余 `device-width`），**之后永不修改**。
   没有重排，就没有残留。
4. **回归闸门**：`src/mobileGate.test.ts` 两条断言守死这件事 —— 静态 HTML 里**不得**出现 viewport meta、
   且**不得**再 `getElementById('viewport-meta').setAttribute(...)`；`verify-mobile-gate` 另外断言
   `document.querySelectorAll('meta[name="viewport"]').length === 1`。
   ⚠ 改动门槛时别顺手把静态 meta 加回来。

### 2：答错扣三分（`src/store.ts`）

新增 `CORRECT_SCORE = 1` / `WRONG_SCORE = -3` 与 `practiceScore(correct, wrong)`，替掉散在三处的 `correctCount - wrongCount`（**地级 / 省级 / 国家**三套熟练度的写入与读回）。

⚠ 关键设计：**分数是派生值**。存储里只持久化 `correctCount` / `wrongCount`，分数每次读回现算（`loadScoreData` / `normalizeRecord` 都调 `practiceScore`）。所以改分值后**历史数据自动按新口径重算，不需要写迁移** —— 而写那种迁移必然漏掉一部分记录。代价是老用户的颜色会变，这是改规则的应有之义（一次答错现在等于三次答错的代价）。**色阶断点（−10/−5/−1/0/+1/+5/+10）没有改**，用户只要求改分值。

### 3：用户管理显示"登录前的游客号"（用户追加需求）

需求原话：「当用户登录之后，用户详情里面需要显示他登录之前的游客号：例如，游客号：1234」。
落在**管理端「用户管理」的每一行**（`src/ui/adminPanel.ts#userRow` 里的 `.admin-user-guest` 胶囊；
文案键 `admin.guestId = "游客号：{id}"`）。

**数据来源**：`functions/api/admin/users.ts` 对每个用户做相关子查询

    (SELECT l.visitor FROM access_logs l
      WHERE l.user_id = u.id AND l.visitor IS NOT NULL
      ORDER BY l.created_at ASC LIMIT 1) AS visitor

两个要点：

1. **不去猜"哪个匿名行后来变成了他"** —— 匿名行没有 user_id，无法归属；而游客编号由浏览器本地生成、
   **登录前后不变**（`src/visitorId.ts`），所以"他自己行上最早的那个编号"就是"登录前那个号"。
   取**最早**而不是最新：换过浏览器就会有多个编号，最早的才是登录前的身份。
   `IS NOT NULL` 保证字段上线前的老行不会把真正有编号的行挡掉 —— 这两条都在本地 D1 上用两行数据逐个验证过
   （早=7777 / 晚=8888 → 取 7777；把早行的编号清空 → 回落 8888；两行都清空 → null）。
2. **新增索引** `idx_access_logs_user (user_id, created_at)`（migration `2026-10-07-access-logs-user-index.sql`）：
   没有它，那个相关子查询会对 access_logs **全表扫描**，而 **D1 按读行数计费**，用户越多越贵。
   复合顺序与 `ORDER BY created_at ASC LIMIT 1` 对齐。线上 `EXPLAIN QUERY PLAN` 已确认
   `SEARCH l USING INDEX idx_access_logs_user`。

⚠ **已知边界（不是 bug，是数据历史）**：`visitor` 列是上一轮才上线的，所以在那之前访问/注册过的老账号
查不到编号 —— 线上 19 个真实用户里只有 2 个有（`rytll→5128`、`Nicky→6654`）。管理端对查不到的账号
**整块不渲染**（不写「游客号：—」占位，避免每一行都堆噪音）。从本轮起新账号会自然带上。

⚠ **需求措辞的一处判断**：「用户详情」实现为**管理端用户管理里的那一行**（那是唯一展示"别人账号详情"的地方）。
若本意是**登录者自己的用户中心**，只需把 `visitorId()` 直接显示出来即可（客户端本来就有），改动很小。

### 验收

- `npm run check` 全绿：tsc（src + functions 两套 tsconfig）+ eslint **0 error**（1 条**既有** warning `src/testCtx.ts`）+ **59 文件 / 782 用例**。
- `npm run build` 通过；真实浏览器**七套**验收脚本全绿（363 项断言）：新增 `verify-mobile-gate` **21/21**（CDP 模拟 iPhone UA + 移动端 metrics + 触屏：桌面不弹、手机弹「请用电脑端访问」、首屏即 `width=1280`、点「继续访问」后布局视口与地图画布都是 1280 宽、选择被记住、二次访问不再打扰、手机爬虫不弹），以及 `verify-admin-traffic` 85/85、`verify-round2` 38/38、`verify-round3` 54/54、`verify-naming` 47/47、`verify-drill-scope` 34/34、`verify-puzzle` 84/84。
  （**后续追加**：修完 1b 与做完 3 之后，`verify-mobile-gate` 涨到 **24/24**、`verify-admin-traffic` 涨到 **89/89**，用例总数 783。）
- 新增测试：`src/mobileGate.test.ts`（11：内联副本逐字一致 + `isPhoneClient` 三个条件）、`src/storeScore.test.ts`（6：三套熟练度都按新分值 + 存量数据重算）。

### ⚠ 本轮已知遗留

1. **没有手机版布局，也不打算做** —— 门槛是刻意的替代方案。若将来要做手机版，门槛的判据（`isPhoneClient`）就是现成的开关点。
2. 门槛生效期间应用仍在遮罩后面运行（首题已出、计时可能已开始）。键盘已让路（见上），但**触屏点击被遮罩挡住**是唯一保证 —— 若将来给门槛加"关闭(X)"之类会漏出交互入口，需要重新考虑。
3. `width=1280` 意味着手机上一屏会缩得比较小（约 0.3 倍），需要双指放大阅读。这是"电脑视图"的固有代价；若嫌小，改 `DESKTOP_VIEWPORT` 一个常量即可（会与 `mobileGate.test.ts` 一起生效）。
4. 分值改动会让**老用户的熟练度颜色变化**（派生值重算），这是刻意的。

## 本轮（2026-10）：IPv4 优先 / 日志折叠 / 游客编号 / 延迟跟随 / 游玩范围 / 排除管理员 / 非洲 0.8

用户一次给七条（原话编号即下文 1–7）：

1. 为什么 ip 采集有的地方采集到的是 ipv6？请优先使用 ipv4。
2. 将浏览器环境和 ip 地址放到折叠栏中，不显示在外层。环境详情点击处放到右边，不单独占一行。
3. 每个游客自动赋予四位数字，例如游客1234，这样用于区分不同游客，对于同一个浏览器，每次访问时后面的四位数字保持不变。
4. 输入模式下，当用户没有开启错误回滚，且开启自动跟随，那么如果回答错误，等待 1 秒后再才跟随，留给用户查看错误的时间。
5. 游玩统计中，不要写用户「未登录」，而是写游客1234等等。需要收集信息包括：游玩模式、出题范围这两个信息。
6. 日志统计和游玩统计需要把管理员排除在外，不参与统计。
7. 非洲的缩放倍率变为原来的 0.8 倍。

### 1：IP 优先 IPv4（`functions/_lib/clientEnv.ts`）

`clientIp()` 重写成「按可信度取舍」：`CF-Connecting-IP`(v4) → **`CF-Pseudo-IPv4`**（Cloudflare 给纯 IPv6 客户端合成的 v4）→ `CF-Connecting-IP`(v6) → 本地 dev 才退到 `X-Forwarded-For`/`X-Real-IP` 并优先挑 v4。新增导出的 `normalizeIp()`：剥端口/方括号、`::ffff:1.2.3.4` 折回点分四段、非法值一律 null（**不再截断后入库** —— 旧实现的"超长值截断成 64 字符"会把垃圾当地址存下来）。

⚠ **要在线上真正拿到 IPv4，需要去 Cloudflare 控制台 Network → Pseudo IPv4 选「Add header」**；不开的话纯 IPv6 客户端仍然只能记 IPv6。另：**不**为了凑 IPv4 去读客户端自带的 `X-Forwarded-For`（可伪造）。

### 2：日志行折叠（`src/ui/adminPanel.ts` + `src/styles.css`）

整行改成 `<details class="log-row">`：`<summary class="log-line">` 是唯一的外层行（时间 · 游客/爬虫 · 判定标签 · 右侧「环境详情」入口），IP、完整 UA、环境字段全部进 `.log-fold`。展开入口用 `margin-left:auto` 推到最右、与用户名同一行，隐藏原生三角标记、用 `▾/▴` 表示状态。

⚠ 踩坑（验收脚本抓出来的）：**不能用折叠区子元素的 `getBoundingClientRect()` 判断"收起了"** —— 新版 Chrome/Edge 用 `::details-content { content-visibility: hidden }` 实现折叠，子元素**仍然有布局尺寸**。验收断言改成看 `details.open` + 行自身高度。

### 3：游客编号（`src/visitorId.ts` 新增）

4 位数字，`localStorage['china-admin-visitor-v1']` 首次访问生成、之后一直复用；存储不可用时返回 `null`（退化成不带编号的词根，不抛错、不反复重试）。`access_logs` 与 `play_logs` 各加一列 `visitor`，服务端 `sanitizeVisitorId()` 只做 `^\d{4}$` 形状校验（**不在服务端兜底生成**：那会把同一个游客记成几十个人）。

⚠ 踩坑（验收脚本抓出来的）：爬虫分支曾硬写 `t('admin.botLabel')`，导致**只有「爬虫」少了编号**、而「游客」有编号 —— 现在两条分支都走 `accessLog.logUserName()`，徽标只换外观不换文本。

### 4：答错后延迟 1 秒跟随（`src/modes/`）

`MapQuizMode` 新增 `onWrong(q)` 钩子（两个答错分支共同收尾收敛成 `afterWrong()`，避免"两处都要记得加"）；`InputMode.onWrong` 在「未开错误回滚 + 开了自动跟随」时置位 `followDelayMs = SELF_WRONG_FOLLOW_DELAY_MS(1000)`，`ask()` 消费一次：题面立刻换、**镜头延后 1s**。暂停/重置/换题都会取消待执行的定时器（否则镜头会在暂停遮罩后面偷偷移动）。

### 5：游玩统计记「模式 + 出题范围」（`play_logs` 加两列）

`play_logs` 新增 `scope_province`（哨兵/adcode）与 `scope_label`（展示名）。前端在上报时从模式取 `getScopeProvince()`、用外壳的 `scopeLabel()` 算展示名（与排行榜侧栏同一份命名）。服务端对这两个字段**只截断长度、不做白名单校验** —— 与成绩提交刻意不同：那是排名数据（写错会污染榜），这只是统计维度，旧版前端多报一个新哨兵不该让整条游玩记录丢掉。列表里未登录显示「游客1234」（不再写「未登录」），`isPlain`/`.log-scope` 与日志的折叠行区分开。

### 6：两个统计都排除管理员（纯 SQL）

`admin/logs.ts` 与 `admin/plays.ts` 的分桶 SQL 与明细 SQL 都加 `AND COALESCE(u.is_admin, 0) = 0`。用 `COALESCE` 而不是 `u.is_admin = 0`：`LEFT JOIN` 上被删除的用户给 NULL，那种行是**访客**，不该被顺手过滤掉。口径必须在 SQL 里，因为**折线是服务端分组算的**，前端过滤只能过滤明细，会与折线自相矛盾。

### 7：非洲系数 0.5 → 0.8（`src/map/followScale.ts`）

只改一个常量。注意方向：**0.8 > 0.75 ⇒ 非洲档现在比通用档更"近"**（与最初"非洲加 6x"那版方向相同、与中间"0.5"那版相反），测试里把这条方向显式断言出来了。

### 验收

- `npm run check` 全绿：tsc（src + functions 两套 tsconfig）+ eslint **0 error**（1 条**既有** warning `src/testCtx.ts`）+ **57 文件 / 765 用例**。
- `npm run build` 通过；真实浏览器**六套**验收脚本全绿：`verify-admin-traffic` **85/85**（本轮由 74 涨到 85，新增折叠结构、入口右对齐、游客编号、出题范围、访问上报带编号等断言，并抓出上面两个真实缺陷）、`verify-round2` 38/38、`verify-round3` 54/54、`verify-naming` 47/47、`verify-drill-scope` 34/34、`verify-puzzle` 84/84。
- **迁移在本地与线上各跑过一遍**（`npm run db:migrate:local|remote`，可重复执行）；线上实测：访问日志 323 行 = 178 匿名 + 145 管理员 + 0 孤儿 + 0 普通用户，排除管理员后正好 178 —— 同时证明了**必须用 `COALESCE(u.is_admin,0)=0`**（写成 `u.is_admin = 0` 会返回 0 行，把匿名行全删掉）。
- 新增测试：`src/visitorId.test.ts`（6）、`src/playLogger.test.ts`（3）、`functions/_lib/clientEnv.test.ts` 的 `normalizeIp`/IPv4 优先/`sanitizeVisitorId`（33 例中含新增十余条）、`inputSubmit.test.ts` 的延迟跟随 5 例、`followScale.test.ts` 的非洲 0.8 与方向断言。

### ⚠ 本轮已知遗留

1. **`CF-Pseudo-IPv4` 需要控制台开启**（见上）——不开就只有 IPv6，代码侧已经尽力。
2 **老数据没有 `visitor`/`scope_*`**：迁移前的行这几列为 NULL，管理端退化成不带编号的词根与「—」，属预期。
3. 迁移文件是**新增的第二个文件**（`migrations/2026-10-06-visitor-and-play-scope.sql`），`npm run db:migrate:remote` 现在指向它；补跑旧库要自己用 wrangler 指定 09-28 那个文件。
4. 游玩统计仍**不显示 IP/环境**（用户没要求，且那条流水要的是"谁在玩什么范围"）——`play_logs` 里其实存了 ua/ip/env/bot，要用随时能加。

## 本轮（2026-09）：九条需求（Tab 重开 / 排行榜口径 / 日志与爬虫判定 / 游玩统计 / 键盘与跟随 / BFS）

用户一次给九条（原话编号即下文的 1–9）：

1. 按下 tab 可以直接重来（自动默认不提交成绩，不需要用户点击「开始」，而是直接重新来，立刻重新即开始）；当用户按下重置这个按钮时，格外弹出一条 toast：「按下tab快速重置」。
2. 对于所有排行榜，即便回答没有全对，也全部允许提交成绩，排行榜的排行规则为：先看正确个数，然后看时间快慢。
3. 管理员的日志记录中，显示完整的浏览器环境和 ip 地址，然后对于境外 ip 和浏览器异常（版本过于落后，无头浏览器等爬虫爱用的浏览器）进行关键词匹配，日志显示不显示游客，而是显示「爬虫」，可以查看我目前网站的日志，判断哪些是爬虫浏览器。
4. 管理员看板中添加「游玩统计」，样式和「日志记录」样式一致，包含曲线图和条目，只不过统计的用户点击「开始」的次数（包括 tab 次数）。
5. 用户管理中，将越晚注册的用户排在前面，管理员顶置。
6. 游玩过程中，按下空格键可以暂停或者取消暂停，按下 alt 键切换是否显示地图地名标签（热切换）。
7. 输入模式下，即便输入栏是空白的，用户也可以点击 enter 确定。
8. 输入模式自由跟随模式下，缩放统一添加 2x。对于非洲，缩放统一添加 6x。
9. 输入模式下的顺序模式，除了要求广度优先搜索，还要求优先选择队列中那些与上一个输入地区相邻的地区。

### 1 + 6 + 7：键盘与输入（`src/appController.ts` / `src/modes/`）

- **Tab 快速重开**：`ModeController` 新增可选 `quickRestart?(): boolean`。`MapQuizMode` 借道 `exit()`（它会完整清 started/paused/settled/rollbacking、停秒表与回滚定时器、停国旗预取）再 `start(false)`（会 `clearSaved()` + `resetProgressState()` 并立刻出首题）；`EndlessMode` = `resetRun()` + `enter()` + `start()`；`PuzzleMode` = 复用「再来一局」那条 `restartRun()`；熟练度分析不实现（Tab 保持浏览器默认焦点切换）。外壳在 `document` 上挂 keydown（绑地图容器会漏掉"焦点在 body"这种最常见情形），**带修饰键的 Tab（Alt/Ctrl/Cmd/Shift）一律交还系统**，设置浮层打开时让路给表单。
- **重置的 Tab 提示**：`onResetClicked()` 最前面弹 `main.tabQuickResetHint`，但**只在 Tab 真的能重开的模式里弹**（计时测验 + 拼图）。熟练度分析的按钮是「重置熟练度」、Tab 在它里面无效，弹了既是错的、也会把紧随其后的「已重置熟练度」顶掉（toast 只有一个元素）。
- **空格暂停 / Alt 标签热切换**：新增 `src/map/labelVisibility.ts`（`null/true/false` 三态**会话级覆盖**，不写进全局设置 —— 临时意图与长期偏好必须分开存）。`ModeCtx.labelsOverride` 注入模式侧；**覆盖为 true 时答题进行中也显示全量地名**（这正是"热切换"的意义），覆盖为 false 时任何阶段都不显示。空格的**关键反例**：世界档要输入 `United States` 这类带空格的地名，故焦点在**非空**文本输入里时不抢（`isTypingNonEmptyText()`）。
- **空 Enter**：`InputMode.onSubmit` 去掉 `!v.trim()` 早退，空串走 `answer(false, true)` 计为答错。`onInput`（边打边匹配）仍要求非空，否则每次清空输入框都会自动判错。

### 2：排行榜口径（`src/scoreRules.ts` + `functions/_lib/validate.ts`）

**资格**：self/click 的**六个范围全部**放开为「至少答过一题」（`totalUnits > 0 && correct <= totalUnits && correct + wrong > 0`）。旧的「全国须已答全对」「省级须全部答对」两条作废。endless 仍须有金币、puzzle 仍须已拼 ≥ 2。

**排序/更优/写入三处必须同口径**（否则会出现"榜上排第 3、系统认为你不如第 5"）：`functions/api/leaderboard.ts` 的 orderBy、`functions/api/score.ts` 的 `ON CONFLICT … WHERE`、`functions/_lib/validate.ts` 的 `isBetter` 全部统一为 `correct DESC, elapsed_ms ASC`（endless 仍 coins → level）。顺带修掉了上一轮交接文档点名的遗留缺陷：**次区域榜此前按用时排序**（`leaderboard.ts` 漏了 `isSubregionScope`），现在与其余榜一致。`isNationScope()` 已无调用点，删除。

**展示**：`metaText()` 不再对省级/单省榜只显示用时，一律「答对 X ｜ 用时」（`leaderboard.nationMeta` 文案同步改成这个形状）。

### 3：日志的完整环境 / IP / 爬虫判定（`functions/`）

- **先看了真实线上日志**（`wrangler d1 execute … --remote` 只读查询 `access_logs`，未做任何写操作），据此选关键词：线上真实出现过的爬虫是 `HeadlessChrome/*`（3 条）、`meta-externalagent/1.1`（27 次）、`bingbot/2.0`（7 次）、`Applebot/0.1`、`360Spider`、`WindowsPowerShell/5.1`；同时确认了**不能误伤**的真人 UA：Chrome/152-154 + Edg、iPhone Safari、微信 `XWEB`/`MicroMessenger`、`baiduboxapp`（内嵌 `Chrome/97`）、`BingSapphire`。
- 新增 `functions/_lib/botDetect.ts`（纯函数，40 个关键词 + 版本过旧 + `navigator.webdriver`）：`bot` 只看「爬虫 / 自动化 / 浏览器异常」三类信号；**`overseas` 只标注、不判爬虫**（境外也有人），前端照样给它画标签。**内置浏览器外壳豁免版本过旧判定**（微信/百度/Bing/UC/夸克的内嵌 Chromium 必然落后，那是厂商打包节奏）。裸 `bot` 子串排除了 `CUBOT` 手机（真人）。
- 新增 `functions/_lib/clientEnv.ts`：`sanitizeClientEnv()` 白名单 + 逐字段截断 + 整体 JSON ≤2000 字符 + **绝不抛错**；`clientIp()`（`CF-Connecting-IP` → `X-Forwarded-For` 首段）、`requestGeo()`（`request.cf`）供两个上报端点共用。前端采集器是 `src/clientEnv.ts` 的 `collectClientEnv()`（永不抛错），`AppController.start()` 的 `api.visit(…)` 已带上它。
- **口径**：日志用户名位置按登录与判定二选一 —— 登录用户显示用户名；**未登录且有判定依据**显示「爬虫」，**未登录且无任何依据**显示「游客」（2026-09 用户二次确认；中间短暂采用过"未登录一律爬虫"，用户随后改掉，理由是那样「爬虫数」恒等于「未登录数」）。判定理由作为补充标签画在同一行。刻意**没有**扩大到游玩记录 —— 那里的未登录仍写「未登录」，因为一条开局流水是真人行为。实现上标签与判定同源：`src/ui/accessLog.ts` 的 `logUserName(entry)` / `showsBotLabel(entry)` 都读同一个 `isBotEntry`。
- ⚠ **必须先跑数据库迁移**：`access_logs` 新增 7 列 + 新表 `play_logs`。见 `migrations/2026-09-28-access-logs-and-play-logs.sql` 与 `npm run db:migrate:remote`。**漏跑不报错、只静默不记录**（上报路径对写库失败只 `console.warn`，不让日志问题影响玩法）。

### 4：游玩统计（`/api/play` + `src/ui/adminPanel.ts`）

新增 `play_logs`（`user_id / mode / source / ua / ip / 地理 / env / bot / created_at`）与 `POST /api/play`（`source: 'start' | 'tab'`）；`GET /api/admin/plays` 同时提供分桶序列与分页明细，分桶**复用** `statsWindow`/`buildStatsPoints`（未改它）。前端 `src/playLogger.ts` 把「永不抛错 + 不产生未处理拒绝 + 带浏览器环境」三条约束收在一处，两个调用点各一行。

**上报点为什么不会重复也不会漏**：`.start-action` 的点击走 document **冒泡**委托（按钮自己的 onclick 已执行完，于是能用 `isStarted()` 过滤掉"点了但没开起来"），Tab 路径调 `quickRestart()`、**从不派发 click**；四个有开始卡片的模式都经 `ui/dom.showStartCard` 生成按钮，类名固定。

管理端「游玩统计」与「日志记录」用同一个 `BoardSpec` 规格对象收敛成一套渲染（首屏与「加载更多」共用同一个行渲染函数 —— 原先两处各抄一份模板）。logs 的 `#admin-traffic*` 三个 id 语义未变，plays 另用 `#admin-plays*`；`TrafficChart` 加了可选 tooltip 文案参数（量词「次访问」/「次游玩」）。

### 5：用户管理排序

`functions/api/admin/users.ts` 改为 `ORDER BY is_admin DESC, created_at DESC`（管理员置顶 + 越晚注册越靠前）。前端不做二次排序。

### 8：输入模式自动跟随的倍率系数（**修订过一次**）

基准（中国按省阶梯 `followZoomFor`、世界按面积反比 `worldFollowZoom`）仍由渲染器算；**系数由模式回答**，纯换算与夹取住在 `src/map/followScale.ts`：
- 中国地级与世界普通国家 **×0.75**；**非洲 ×0.5**；
- **面积极小、几乎难以察觉的国家（`tiny_countries.json` 那 6 国）不乘系数**，`focusWorldCountry` 直接使用世界跟随上限 28x（判定在渲染器里做，靠 `tinyCountries.isTinyCountry()`，与「忽略面积极小的国家」这条**设置**无关）；
- 非法系数（`NaN`/`Infinity`/**≤0**）在 `scaleFollowZoom` 里按 **1** 兜掉 —— 系数 0 会被夹成 `MIN_ZOOM`，表现为"跟随之后镜头突然拉到最远"，而上一版恰好有个「传 0 表示不加成」的调用点。

⚠ **这一条改过两次，务必按当前定义读**：第一版是「**加** 2x / 非洲加 6x」（用户随后指出方向说反了），现行是「**乘**系数把镜头拉远」。因为运算类型从加减变成乘除，旧的 `followZoomWithBonus`、`SELF_FOLLOW_ZOOM_BONUS(_AFRICA)`、以及两个只作历史注记的 `SELF_FOLLOW_ZOOM = 12` / `ENDLESS_FOLLOW_ZOOM = 12` 全部**删除**，`focusUnit`/`focusWorldCountry` 的第 2 个参数语义定为「倍率系数，缺省 1 = 不动基准」；调用点同步为 `focusUnit(adcode, cityFollowScale())` / `focusWorldCountry(iso, worldFollowScale(continent))` / 无尽的 `focusUnit(adcode)` / 探针的 `focusUnit(adcode)`。上一版那处「`focusUnit(adcode, 0)` 表示不加成」若被遗留到乘法语义下会把镜头拉到最远，故纯函数对 ≤0 做了兜底。

⚠ 顺手修掉一处长期隐患：`renderer.focusUnit(adcode, _zoom)` 的第二个参数**从前被完全忽略**（真实倍率来自按省阶梯），调用方以为传 12 就是 12x。现在它的语义是**倍率系数**（缺省 1 = 不动基准），调用点已同步（`endless` 传 `focusUnit(adcode)`、`probe/mapProbe` 同样不传）。`focusWorldCountry(iso, scale = 1)` 缺省 1，故既有探针断言（`verify-round2`）逐字未变。

### 9：顺序出题邻接优先

`bfsStep` 新增 `lastId`：**仍从队列里取**（`queue.splice(idx, 1)`，未选中的留在原位），但优先取队列中**与上一个已作答单位相邻**的那一个（按队列顺序取第一个命中的），没有才取队首。因此「不可能出现空洞」这条性质与广度优先都不变 —— 若改成"lastId 的任一未作答邻居优先"，就退化成旧的贪心游走、空洞重现。`InputMode` 用新字段 `lastAnswered`（在 `onAnswerStart()` 里赋值，**对错都更新**；`lastGreen` 只在答对时更新，用它会让答错后的下一题跳回上一次答对的地方），并一并持久化/恢复/暴露给探针。

### 验收

- `npm run check` 全绿：tsc（src + functions 两套 tsconfig）+ eslint **0 error**（仅 1 条**既有** warning `src/testCtx.ts` 函数 62 行 > 60，本轮无人改该文件）+ **55 文件 / 739 用例**（基线 49 / 615）。
- `npm run build` 通过。
- 真实浏览器验收（headless Edge + 真实指针事件，全部在最终改动之后重跑）：`verify-admin-traffic` **74/74**（原 38；含完整 UA 129 字一字不差、完整 IP/地理、环境详情逐字段、**未登录有依据→「爬虫」/ 无依据→「游客」两条路径**、匿名游客行无爬虫描边、翻页与首屏同构、游玩统计的曲线/条目/来源/空态/另一组容器 id/「次游玩」量词）、`verify-round2` **38/38**（含顺序模式 48/48 题 0 重复全覆盖）、`verify-round3` **54/54**、`verify-naming` **47/47**、`verify-drill-scope` **34/34**。
- 基线在动工前用 `git worktree` 建在 `777b568` 上跑过一遍（49 文件 / 615 用例全绿），因此"新增的失败"与"既有的失败"不会混在一起。

### ⚠ 本轮已知遗留（都**没有**动，供下一个 AI 判断）

1. **提交资格不校验 `correct + wrong <= totalUnits`**，也没有服务端池子大小校验：`totalUnits` 本身由客户端上报，因此"答对数 > 题目总数"或谎报分母在理论上仍可提交。这是**改动前就存在**的口径（旧实现同样信任客户端的分母），本轮严格按需求只改「是否要求全对」。要真正收紧需在服务端按范围算池子大小，是一个独立的改动。
2. **`DESIGN.md` 的 §17.5 与 §1 的老段落有历史口径残留**（"只有两个范围可提交"等），已在两处加了「口径更新」说明，但没有重写历史段落。
3. **Alt 的会话级覆盖不随模式切换复位**（模块级单例，刷新才清）。这是刻意的（"这一局想不想看地名"是跨模式的会话意图），若用户口径改成"切模式即复位"，在 `switchMode` 里加一行 `setLabelOverride(null)` 即可。
4. **无尽闯关与拼图的游玩中不显示全量地名**（无尽渲染的是金币标签、拼图盘面没有地名），因此 Alt 覆盖在它们的**开始卡片阶段**才改画面。这是玩法本身决定的，不是缺陷。
5. **探针未新增键盘路径端点**：Tab/空格/Alt 三条路径有单测（`labelVisibility.test.ts`、`inputSubmit.test.ts` 等）与源码级守卫，但没有像"真实按键事件 → 画布变化"那样的运行时断言。若要补，`src/probe/uiProbe.ts` 是落点。

## 本轮（2026-09）：排行榜随范围切换 + 拼图成绩范围放开 + 困难档容差例外 + 碎片视觉

用户报三条（原话）：「**切换模式/下钻/返回顶级时排行榜有时候不会切换**」「**拼图模式现在拼完之后没有成绩提交按钮，排行榜也为空白**」「**困难模式下港澳台与海南岛进入可吸附范围时要保留绿描边**」，随后一轮追加：「**改成困难档不给描边、只把判定范围放宽到 15px（未成组时），其余地区不变、成组后回到 5px**」「**简单档去掉辉光、描边变细到 2px**」「**港澳这些微小碎片永远最后出现**」「**世界范围也遵循同样规律**」「**吸附后的碎片之间不要阴影，只留组最外层**」。四轮 grill 定稿，问题与决定都记在 `grill-rounds.log`。

### 1. 排行榜不切换（真缺陷，根因明确）

**根因**：`MapQuizMode.syncScopeView()` 的省级全国分支里，`renderer.setProvinceMode(true, …)` **自己会把下钻的省清掉**（`renderer.ts` 内部的 `else if (this.viewProvince)` 分支）并且**从不发 `onViewChange`**。紧跟其后的 `if (renderer.currentProvince()) renderer.backToNation()` 因此**永远为假**：从省级档钻省返回顶级时既不补发视图变化、也不同步进度，而外层 `backToNationFromMap()` 只更新进度与按钮高亮 —— 侧栏就一直停在下钻那个省的榜上。市级档与世界的返回都正常，这种不对称正是用户感觉到的"有时候"，而**省级是默认档位**，最容易撞上。

**修法**：① `MapRenderer.notifyViewChange()`（新增，补发一次 `onViewChange`）+ `syncScopeView` 里"提前取 `wasDrilled`、事后补发"（补发时 `syncingScope` 仍为 true，模式自己的 `onViewChange` 会早退，不重入）；② `backToNationFromMap()` 两个分支末尾一律 `void this.refreshSidePanel()`（兜底，将来新增模式漏发事件也不会再卡榜）；③ 侧栏渲染策略改成"**有快照就立刻渲染 + 后台重取，没快照就立刻换标题并显示「加载中」**"，绝不把上一个范围的名单留在屏幕上。

### 2. 侧栏缓存层重写（`src/leaderboardStore.ts`）

旧实现把 Promise 当缓存永久存着，命中就再也**不重取**（别人新提交的成绩整个会话看不到），而且一个卡住的请求会让那个范围**整个会话再也刷不出来**（Promise 既不 resolve 也不 reject，永不被清除）。现在：快照只服务显示、并发合并成一次请求、请求带超时且超时后释放并发槽、**迟到的响应一律丢弃**、新鲜期内（2s）复用快照以免五个刷新触发点在同一瞬间各打一次接口。提交成功后作废该范围快照。

⚠ 这两个文件此前**没有任何测试**（这正是缺陷能长期潜伏的原因）。本轮新增 `leaderboardStore.test.ts`（7 例）与 `ui/leaderboardPanel.test.ts`（6 例，用假 DOM）。

### 3. 拼图成绩范围放开（`docs/adr/0009`）

默认进入拼图模式落在**省级全国**，而那一档原先不可提交：`collectResult()` 返回 null → 完成卡片不渲染「提交成绩」；服务端 `PUZZLE_SCOPES` 也不接受那一档，榜**结构上永远是空的**（线上实测 `?mode=puzzle&scope=__province_nation__` → `{"entries":[]}`）。现在**所有合法范围都可提交**，范围合法性统一复用 `normalizeScope()` 白名单（删掉了前后端两份手写名单）。顺带修掉 `PuzzleMode.scope` 硬编码为省级全国、与本地记住的档位不一致（表现为"地图是世界/市级、排行榜却按省级全国去查"，市级档下开始卡片还会打印 `__province_nation__`）。⚠ **服务端白名单改了，必须重新部署 Cloudflare Functions**。

### 4. 困难档容差例外（`docs/adr/0010`）

新增 `src/puzzle/specialUnits.ts`：**孤悬/极小**单位 = 面积 ≤ 0.1614 度² ∪ 当前范围内无陆地邻居 ∪ 另算岛国名单（英/爱/印尼/多米尼加/海地/巴新/东帝汶/文莱 8 个）。困难档下它们**还是单独一片时**容差 15px，成组后回 5px，判定**取两方较宽**的；**提示照旧一个都不给**。实测：省级全国 = 港澳台海南 4 个，世界全国 = 51/194。`PuzzleState` 的容差由单一数值改成按组算（`PuzzleSnapOptions`），并顺带修掉"拼完 → 改难度 → 再来一局"仍沿用旧容差（`ensureState` 改为按 `难度|粒度|范围` 的 key 重建）。

### 5. 视觉与手感四条

- **简单档提示**：`stroke-width` 2.5 → **2**，删掉 `.can-snap` 的绿色辉光（`drop-shadow`）。
- **投影**：删掉每片包装上的 `drop-shadow`（吸附成组后它会在**接缝处**露阴影）；改为拖动时在画布**最底层**临时插一层"该组所有片的轮廓副本"，对整层做一次 `drop-shadow` —— SVG filter 取的是**联合轮廓**，于是只有外围有阴影（`view.updateDragShadow`）。
- **卡槽供应顺序**：`supplyOrder()` 把「极小」碎片（只按面积）排到池尾，正常片全出完才轮到它们。
- **邻接兜底**：`bboxGap` 改成**经度环形**处理，并新增 `pieceGap()`（**逐多边形**最小间距）替换兜底与搭桥里的整片 bbox 间距 —— 后者会被海外领地与跨 180° 经线撑爆，实测把冰岛配到俄罗斯、马尔代夫配到中国、新西兰配到南非、塞浦路斯配到挪威。同时修掉 `connectComponents` 的一处"注释与实现不符"：它找到了最近的一对片，却把边加在两个块的**首个成员**上（于是世界档的桥全落在字母序最靠前的 AFG 身上）。

### 验收

`npm run check` 全绿（tsc 前后端 + eslint + **615** 用例，本轮 +25）；`verify-puzzle.mjs` **84/84**（原 75，新增：孤悬/极小名单与 15px 放宽、成组后回 5px、简单档不放开、2px 无辉光、碎片默认不投影、拖动整组阴影、港澳排最后、省级全国可提交）；`verify-round2` 38/38、`verify-round3` 54/54、`verify-naming` 47/47、`verify-drill-scope` 34/34。

⚠ 顺手发现但**本轮没修**（用户明确选择不动）：答题模式的「次区域榜」实际按用时排序，而 `CONTEXT.md` 写明应与世界全国同语义（答对题数优先）——`functions/api/leaderboard.ts:17` 漏了 `isSubregionScope`。拼图不受影响（它按 `mode === 'puzzle'` 先行判断）。

⚠ 踩坑：`scripts/verify-puzzle.mjs` 的 `resetClick()` 只点两次「重置」。范围放开后**省级档下已拼 ≥ 2 时重置会弹结算卡片**（从前不进榜，必定直接回开始卡片），于是脚本卡在"结算卡片盖住开始卡片 → 难度按钮为 null"。已给 `resetClick()` 补一步"卡片在就关掉"。

## 本轮（2026-09）：两处口径微调（范围外灰更贴近空白 + 红显 1.5s → 1.1s）

用户口径（原话）：「**下钻后非考试范围的灰色再向空白颜色靠近一些**」「**打错红色警告出现时间由 1.5 秒变成 1.1 秒**」。

### 1. `MapTheme.inactiveFill` 换值（第 1 条）

| 主题 | 空白底色 | 初版 | **现值** | 亮度差（初版 → 现） |
|---|---|---|---|---|
| 明 | `#d1d5db` | `#b0b5bd` | **`#c2c6cd`** | 32.1 → **14.9** |
| 暗 | `#374151` | `#2b3441` | **`#303948`** | 13.0 → **7.8** |

- 亮度＝`0.299R+0.587G+0.114B`（与验收脚本同款）；ΔE76 明 11.7 → 5.4、暗 6.1 → 3.6（JND ≈ 2.3，仍在可辨之上）；**相对亮度差**明 15.1% → 7.0%、暗 20.4% → **12.2%**（暗主题绝对差更小但相对差更大，这是它仍分得开的依据）。
- **只动一个令牌**：可见性（透明/浅灰）与可交互性（恒 `silent`）的口径一律不变，练习范围/出题池/排行榜不受影响（见 DESIGN §18 与 §20.1）。
- 新增口径闸门：`layers.test.ts` 的"浅灰比底色更深"改为**遍历明暗两主题、锁亮度差在 (5, 20) 开区间**（下界=分得开，上界=防止再漂回差 ≈ 32 的大灰）。
- 同步改的文档/脚本：`theme.ts`（两行 + 接口文档注释）、`CONTEXT.md`「下钻后隐藏无关地区」、`DESIGN.md` §18.1 表格 / §18.2 亮度差段、`README.md` 功能清单、`scripts/verify-drill-scope.mjs`（两处硬编码色值 + 像素直方图分类键，并新增"亮度差"输出）。

### 2. `ROLLBACK_RED_MS`：1500 → 1100（第 2 条）

- `src/modes/mapQuizMode.ts`：`1500` → **`1100`**，注释写明沿革 700 → 1500（ADR 0005 那轮）→ 1100（本轮）。
- ⚠ **ADR 0005 是历史决策记录，保留 1500ms 不改写**；现行口径以常量注释与 `CONTEXT.md`「错误回滚」词条为准（词条与示例对话都已改成 1.1 秒）。
- 探针 `src/probe/quizProbe.ts` 直接 `import { ROLLBACK_RED_MS }`（等待 `ROLLBACK_RED_MS + 350`），故实现与断言不会漂移；`scripts/verify-round2.mjs` 的期望值与文案同步改成 1100。
- 全仓 `1500` 复查结论：**只剩这三类**——① 与本题无关的 `sleep(1500)` / adcode `150000` / `formatElapsedSeconds(1500)`（`build-flag-thumbs.mjs`、`verify-puzzle.mjs`、`province-abbr.json` 等，**不要动**）；② ADR 0005 的历史记录（**不要动**）；③ 本轮已改掉的口径引用（`mapQuizMode.ts`、`verify-round2.mjs`、`README.md`、`CONTEXT.md`）。

### 建议验证

1. `npm run check`（typecheck + lint + 单测）与 `npm run build`；
2. `node scripts/verify-drill-scope.mjs` → 34/34（看"灰是「比空白底色更深一档的浅灰」"那条的 `亮度差` 字段）、`node scripts/verify-round2.mjs` → 38/38（"红显时长为 1100ms"）；
3. 手工目测：关掉「下钻后隐藏无关地区」下钻某省 —— 范围外那片灰应当**比上一版更接近空白、但仍一眼看得出是"范围外的地区"**；暗主题同样看一眼。⚠ 这一条**只能靠人眼定稿**：脚本能证明的是"比其他空白更深且色差在区间内"，证明不了"顺眼"。

## 本轮（2026-09）：管理端流量看板改成折线图 + 时间范围选择

用户口径（原话）：「将管理员用户管理的流量看板做成折线图（鼠标挪到标记点显示当天或小时的访问量），而且可以选择，近一天，近7天，近一个月的时间范围。」

### 1. 口径与形状

- **位置不变**：仍在管理员面板的「**日志记录**」子视图里（没新开 tab、没挪去用户管理）；下方访问明细与「加载更多」原样保留，图表排在明细之前。
- **时间范围**：三个范围按钮「近一天 / 近七天 / 近一个月」，样式复用项目既有的分段按钮 `.mode-segmented`（卡片里去掉玻璃态投影、高度降到 32px，见 `src/styles.css` 的 `.admin-traffic` 段）。**默认近七天**。
- **粒度**：近一天 = 按小时 **24 个点**；近七天 = 按天 **7 个点**；近一个月 = 按天 **30 个点**。
- **tooltip**：`trigger: 'axis'` + `appendToBody`（面板容器可滚动，挂容器里会被裁），文案 `9月16日 · 34 次访问` / `9月16日 14:00 · 12 次访问`（同一个文案键 `admin.trafficTooltip`，日期/小时的差别在标签格式化里）。
- **空态**：整段窗口一次访问都没有 → 图表**照画**（时间窗口与粒度仍然可见），下方多一行 `admin.noStats`（暂无统计数据）。
- **切范围只刷新图表**：不重建 `#admin-body`（因此不丢滚动位置、不闪一下），按钮只切 `.active` + 换个 series。

### 2. 后端：窗口由服务端生成，缺桶服务端补 0

`functions/api/admin/logs.ts` 的 `?view=stats&range=day|week|month`（**旧的 `days`/`hours` 两个字段已删除**，全仓唯一消费者是 `src/api.ts` 的 `adminStats`，已同步）。响应统一成 `{ range, unit: 'hour'|'day', points: [{ label, count }] }`，**升序**、长度恒等于该范围的桶数。

纯逻辑抽到 `functions/_lib/statsWindow.ts`（17 条单测）：

- `statsWindow(unit, points, now)` → 桶标签序列 + 窗口起点。按天用**日期算术**（跨夏令时不会算成 23/25 小时），按小时用整点步进；
- `buildStatsPoints(labels, rows)` → **以窗口为准**逐个取值、缺桶补 0、窗口外的行丢弃。⚠ 反过来（拿 SQL 结果直接画）会得到一条时间**不等距**的折线：3 天前的记录会被画在昨天的位置上 —— 这是本轮最需要防的错；
- `normalizeStatsRange(value)` → 非法值回落 `week`（**绝不为非法参数报 4xx/500**）。

⚠ **时区口径（本轮已修的一处真实缺陷，别再退回 `'localtime'`）**：最初用 `strftime(..., 'localtime')` 分组、`statsWindow()` 用宿主时区 `Date` 造标签，两者在本地 dev 下**实测差整整 8 个小时桶**——D1 没有 tzdata，`'localtime'` 一律按 UTC 解析（与 `'utc'` 的分桶逐桶相同，32/32），而 `wrangler pages dev` 里 Worker 的 `Date` 跟宿主时区（本机 +08）。症状是标签写 14:00、计数来自 UTC 14:00，折线整条错位却"看着有数据"（纯函数单测各自都对，所以单测抓不到）。
现行做法：**两侧用同一个显式偏移**（`SITE_TZ_OFFSET_SECONDS` = 北京时间 UTC+8）——SQL 绑 `created_at / 1000 + ?2`、JS 侧加同一偏移后用 `getUTC*` 渲染；改一个常数就同时改两边。口径与验收见 [ADR 0008](docs/adr/0008-traffic-buckets-use-explicit-site-timezone.md)，集成验证脚本是仓库外的 `地图记忆-seed/local-backend-check.mjs`（真 `wrangler pages dev` + 独立 `--persist-to` 的本地 D1，把接口返回的桶与独立算出的期望值逐桶比对）。

### 3. 前端：三层拆分（沿用地图渲染的分法）

| 文件 | 职责 | 为什么不塞一起 |
|---|---|---|
| `src/ui/trafficSeries.ts` | **纯逻辑**：范围→粒度/桶数、桶标签解析/格式化、tooltip 与轴文案、y 轴整齐上界、配色、option 构造 | 全是"错了也看不出来"的换算（桶顺序、粒度文案），31 条单测直接对着 option 与文案断言 |
| `src/ui/trafficChart.ts` | ECharts 实例**生命周期**（建/更新/resize/读回/销毁）+ `convertToPixel`（探针取标记点像素） | 与 `map/inset.ts` 同一手法：面板每次重建 `#admin-body` 都会换掉容器元素，谁建谁销 |
| `src/ui/adminPanel.ts` | 装配：范围按钮、请求、空态、把实例与 DOM 生命周期对上 | 面板只管编排 |

三点硬要求（都踩过）：

1. **必须 dispose**：`render()` 与 `renderBody()` 都会重建 DOM，两处都在最前面调 `disposeTraffic()`；切走子视图（去用户管理）也销毁。验收脚本用「反复切 tab 3 轮后 canvas 数不增长」+「切走后 `mounted === false`」两条锁住。
2. **容器高度固定 `240px`**：ECharts 在 0 高容器里画成 0×0；`TrafficChart` 另挂 ResizeObserver，容器从隐藏转显示时自动 resize。
3. **配色只用既有色**：折线取 CSS 变量 `--accent`（明 `#10b981` / 暗 `#34d399`，跟随 `body.theme-dark`）、轴线 `--muted`、网格线 `--panel-border`、标记点描边 `--panel-bg`；tooltip 三色取 `MAP_THEMES` 的既有令牌。**没有新造一套颜色** —— 因此暗色模式不需要第二份颜色表，但**主题切换后要重画一次**：`AdminPanel.applyTheme()` 接在 `appController.toggleTheme()` 与设置面板保存两处。

### 4. 验收

- 单测 **577**（+48）：`src/ui/trafficSeries.test.ts` 31 条（范围口径 / 标签互逆 / 防御性补桶 / 文案逐字 / niceMax / 配色回落 / option 与 tooltip formatter）、`functions/_lib/statsWindow.test.ts` 12 条（窗口边界 / 跨月 / 跨天 / 补 0 / 脏数据）；
- 运行时新增 `scripts/verify-admin-traffic.mjs`（**38/38**，截图 `docs/shots/admin-traffic-1..7-*.png`）；
- 回归：`verify-round3` 54/54、`verify-drill-scope` 34/34（两者都覆盖主题切换路径，本轮动过）。

### 5. 验收脚本的两个环境难点（可复用）

1. **本地静态服没有 Pages Functions**：用 `Page.addScriptToEvaluateOnNewDocument` 在**页面脚本之前**替换 `window.fetch`，`/api/**` 返回打桩数据、**其余请求（`data/*.json` 等地图数据）转发真网络** —— 少了这一步应用根本起不来（地图数据也会被打桩吃掉）。
2. **管理端要管理员登录态**：同一时机写 `localStorage['china-admin-session-v1'] = { token, user: { isAdmin: true, … } }`（键见 `src/authStore.ts`），然后**真实点击** `#user-center` → 菜单里的「日志记录」。
3. 打桩数据刻意做成**确定性公式**（近一天第 i 点 = `(i+1)×3`、近七天 ×7、近一月 ×11，标签固定到 2026-09-1x），于是 tooltip 可以**逐字比对**：hover 近七天第 5 个点必须得到 `9月14日 · 35 次访问`、近一天第 4 个点必须得到 `9月15日 18:00 · 12 次访问`。这比"包含某个数字"强得多。
4. 标记点像素由探针 `adminTrafficPointPixel(i)` 给出（面板诊断视图 → `TrafficChart.convertToPixel({ seriesIndex: 0 }, [i, count])`），脚本再派发真实 `Input.dispatchMouseEvent`；**另外数了一遍画布上的绿色像素**（8778 个）证明折线与面积真的画出来了，而不只是"配置写对了"。

### 建议验证

1. `npm run check`（typecheck + lint + 577 单测）与 `npm run build`；
2. `node scripts/verify-admin-traffic.mjs` → `38/38 通过`，刷新 `docs/shots/admin-traffic-*.png`；
3. 手工：登录管理员 → 右上角头像 →「日志记录」→ 看折线（默认近七天），点三个范围按钮（点数 24/7/30 与 x 轴刻度跟着变），鼠标在标记点上停一下看 tooltip，切到用户管理再切回来确认图还在、没多出画布。

## 本轮（2026-09）：全局设置「下钻后隐藏无关地区」

用户口径（一次说清，无追问）：全局设置里加开关，**默认打开**；打开 = 现在的样子；关闭后下钻到次级区域**依然显示其他地区**，但**无法交互**，填充为**比空白底色更深一档的浅灰**；关闭时下钻到省份**依然保持五级精细度分段**。

**一条开关改了四处渲染结果**（这是本轮最需要先读的一张表）：

| 作用点 | 开（默认） | 关 |
|---|---|---|
| 范围外的面可见性 | 透明 | 浅灰 `#c2c6cd`（暗 `#303948`；2026-09 由 `#b0b5bd`/`#2b3441` 向空白靠近一档） |
| 范围外的面可交互性 | `silent` | **同样 `silent`（刻意不变）** |
| 下钻时的省界线 | 只画本省 | 邻省省界照画 |
| 下钻时的精细度档 | 强制 lossless | 按 zoom 走五档 |

### 1. 关键判断：只切"可见性"，不切"可交互性"

`silent` 是本项目「惰性面」的全部含义（见 `CONTEXT.md` 的**惰性面**、`docs/adr/0005`）：ECharts 对 `silent` region 既不派发鼠标事件也不做 emphasis。本轮把「可见性」与「可交互性」当成**两条正交的轴**：`layers.ts` 的 `outOfScopeFill()` 只改 `areaColor`，`silent` 两态恒为 true。于是关闭后得到的是「**看得见的惰性面**」——占位置、画浅灰，但悬停不高亮、没有 tooltip、点了等同点空白（有下钻层级时退回上一层）。

⚠ 值得记住的实测细节：**zrender 的 `findHover` 对 silent 元素返回 `topTarget` 但不返回 `target`**（`node_modules/zrender/lib/Handler.js` 第 283 行附近），所以 `event.target` 仍是 `undefined` —— 点击灰区**照旧**走 `getZr().on('click')` 里的空点分支 → `onBlankClick()`。这不是本轮新行为，而是既有惰性面语义的自然延续（README 第 53 条早就写着"点击等同点空白"）。**若将来想让灰区"点了完全没反应"，必须改成 `silent: false` + 在 `wireChartClick`/`wireChartHover`/tooltip 三处各自加范围守卫，还要接受"下钻后点不动就没法靠点空白退回上一层"这个代价**——本轮刻意没做。

### 2. 为什么关闭后必须放弃"下钻强制无损档"

开着时下钻某省，视口里只剩一个省，顶点再多也被 `cull.ts` 的视口裁剪挡住（`ignore=true` 让 zrender 直接跳过 `buildPath`），所以 `tierOfZoom(zoom, drilled=true)` 直接给 lossless 最划算。关掉后邻省**仍在绘制**——若还强制 lossless，它们会顶着 100% 顶点的几何参与每帧构建，拖动缩放明显掉帧。故新加纯函数 `tiers.ts::drillForcesLossless(drilled, hideUnrelatedOnDrill)`，只有"下钻 **且** 隐藏无关地区"才强制。用户那句「依然保持五级精细度分段」说的就是这件事。

实测（广东省，1440×900）：下钻取景 zoom ≈ **7.37**，按阈值本该是 `fine`；开着时被强制成 `lossless`，关掉后回到 `fine` —— 这条差异是验收脚本里最直接的证据（若某省的取景倍率恰好 ≥14，这条就验不出来了，脚本里显式断言了 `zoom < 14`）。

### 3. 改动的文件

- `types.ts`（`Settings.hideUnrelatedOnDrill` + 长注释）、`store.ts`（默认 true + 旧档回落/脏值归一）、`index.html`（新增「地图下钻」分区与 `#set-hide-unrelated-drill`）、`ui/settingsPanel.ts`（读写该开关）；
- `map/theme.ts`（新令牌 `inactiveFill`：明 `#c2c6cd` / 暗 `#303948`，比 `background` 深一档里较轻的那一档；初版为 `#b0b5bd` / `#2b3441`，2026-09 用户要求"再向空白靠近一些"）；
- `map/layers.ts`（`LayerInput.hideUnrelatedOnDrill` + `outOfScopeFill()`；地级分支把"范围外"判定挪到金币色**之前**，世界分支范围外照画国界）；
- `map/tiers.ts`（`drillForcesLossless()`）；`map/renderer.ts`（字段 + `setHideUnrelatedOnDrill()` + `layerInput()` + `activeTier()` + `buildLineData()` 保留邻省 + 诊断视图新增 `hideUnrelatedOnDrill`/`activeTier`/`provinceLineAdcodes`/`dataToPixel`）；
- `appController.ts`（建渲染器时与保存设置时各灌一次）；
- `probe/mapProbe.ts`（`drillShade()` 只读回读 + `renderedRegions()` 增加 `setting`/`borderWidth`/`outOfScopeSilent`）。

### 4. 验收

- 单测 **529**（+15）：`layers.test.ts` 新增"关闭后浅灰可见但静默/边界/比底色深/金币不覆盖范围外/未下钻时无影响"、`tiers.test.ts` 新增 `drillForcesLossless` 与"关闭后五档齐全"、`store.test.ts` 新增默认值与归一化；
- 运行时新增 `scripts/verify-drill-scope.mjs`（**34/34**，截图 `docs/shots/drill-scope-1..6-*.png`），**全部走真实路径**：真实点击设置面板保存 → 读回 ECharts 真正生效的 `geo.regions` → 真实鼠标事件 → 画布像素直方图；
- 回归：`verify-round2` 38/38、`verify-round3` 54/54 未受影响（默认取值下行为零变化，`renderedRegions` 的旧断言照旧通过）。

⚠ **验收脚本踩过的两个坑**（都值得记住，已写进脚本注释）：
1. **画布不止一张**：zrender 建了两张 1410×745 的 canvas，**索引 1 才是主画布**（悬停高亮画在另一张上，实测只有那张的指纹会随悬停变化）。取样时逐张找"该点有内容的"，别写死索引。
2. **地图空白处画布是透明的**：用户看到的空白色来自 CSS（`#map { background: var(--map-bg) }`），故像素取样必须回落到容器的计算背景色，否则会把"空白"读成"没有颜色"。另外单点取样会**正好落在白衬底的地名标签上**（实测：澳门中心被珠海的标签盖住）——所以"其他地方变灰了"这条断言用的是**同屏颜色直方图**（多出的浅灰格 621 ≈ 少掉的空白格 655 − 34 条画在灰面上的省界/标签），比单点稳得多。

### 建议验证

1. `npm run check`（typecheck + lint + 单测 529 条）与 `npm run build` 均须通过；
2. `node scripts/verify-drill-scope.mjs` → 应输出 `34/34 通过`，并刷新 `docs/shots/drill-scope-1..6-*.png`；
3. 回归三个老脚本：`verify-round2.mjs` 38/38、`verify-round3.mjs` 54/54、`verify-puzzle.mjs` 75/75（本轮的默认取值 = 历史观感，故它们必须一字不改地通过）；
4. 手工：打开「设置 → 地图下钻」看开关默认在开；进点击/输入模式市级档，点某省下钻 → 其他省不可见；关掉开关并保存 → 当前画面**当场**变成"其他省浅灰可见"，但悬停不高亮、点了等同点空白（退回全国）；再点开 → 恢复原样；顺手核对左下缩放角标：关闭时该省的档位会比"强制无损"时低一档（如广东 7.37x → 从 lossless 回落到 fine）。

### 5. 注意事项（给下次改动）

- **不要**把范围外面改成非 `silent`：那是"能不能点"的口径变更，会连带 `wireChartClick` / `wireChartHover` / tooltip 三处守卫与"点空白退回上一层"的出口（理由见第 1 条）。
- **颜色只有一处来源**：`MapTheme.inactiveFill`。验收脚本里另写了一份色值期望（刻意的独立重述）——改颜色时脚本会红，那正是提醒你复核观感并同步改脚本。**这条剧本已经真的发生过一次**：2026-09 用户要求"灰色再向空白靠近一些"，把 `#b0b5bd` → `#c2c6cd`（暗 `#2b3441` → `#303948`）时，红的正是 `verify-drill-scope.mjs` 的两处硬编码色值与像素直方图的分类键（直方图按**精确 RGB** 分类，所以两个颜色变近也不会被归成一类）。
- **`buildLineData()` 有副作用**：它顺手写 `lineBoxes`（逐帧裁剪用）与 `lineAdcodes`（探针用），两者必须与返回的折线逐项对齐；这轮把过滤结果先算成 `kept` 再同时喂给三处，就是为了不让三个数组漂移。
- 「惰性面」在 `CONTEXT.md` 里现在明确写成"可见性与可交互性正交"，下次再有人问"灰的能不能点"，答案是**不能**。

## 本轮（2026-09）：P0/P1 重构（口径注册表 + 模式目录 + 渲染器拆分）

来自一次"哪里亟待重构"的自评，六项一次做完。**行为零变化**（514 单测、214 个运行时断言全绿）。

### 1. 取名口径注册表 `src/modes/naming.ts`（P0）

问题：加一档「省会」要改 11 个文件（`types`/`modes/types`/`namingStore`/`province`+json/`mapQuizMode`/
`click`/`input`/`index.html`/`chromeSync`/`messages.json` + 探针与验收脚本），漏一处就是界面自相矛盾。

现在：一张表三组，每档自己声明**段按钮文字 / 只在哪些模式提供 / 题面名 / 标签名 / 题面图 / 标签缩略图 /
输入判题 / 占位提示**。消费方全部改成"问表"：
- `ui/namingControls.ts` 按表**生成**三组段按钮（`index.html` 只留空容器）——顺带干掉了 `#world-name-flag`
  在 `chromeSync` 里那段按模式显隐的硬编码（现在是表里的 `modes: ['click']`）；
- `chromeSync.syncNamingRows` 按表遍历显隐与高亮；`appController` 的接线从 3 段变成 1 个循环；
- `InputMode.matchInput` / `placeholderForNaming` 只剩"取当前档 → 交给它"；
- `MapQuizMode` 的 `displayNameOf` / `worldNameOf` / `provinceLabelTextOf` / `worldFlagSrc` /
  `browseLabelContentOf` 全部退化成薄转发（`provinceQuestionNameOf` 已删除）。

⚠ **踩到的坑（值得记住）**：验收脚本按 **id** 点击按钮（`#world-name-capital`…），而按钮改成 JS 生成后
id 就没了 → 脚本报 `Cannot read properties of null`。修法是让生成规则**复刻**原 id：
`容器 id 去掉 -toggle` + `-` + 取值。`naming.test.ts` 现在有一条不变量把"生成的 id"与"验收脚本里的选择器"钉在一起。

⚠ **测试抓到的一个真坏味道**：省级三档最初共用一个 `labelName(id, data, naming)`，内部按 `naming.province`
分支 —— 于是"full 档的函数"配 abbr 的口径会算出简称（拿错档也不报错）。改成每档闭包只认**自己那一档的取值**，
并加不变量：同一档在多种口径组合下产出的文本必须一致。

### 2. 模式目录 `src/modes/capabilities.ts`（P0+P1）

问题：模式事实散成 30 余处 `mode === 'x'`（`chromeSync` + `appController` 里 32 处），加模式要逐处补；
模式名有**四份重复**（tab 静态 HTML、`mode.*.title`、`startTitle`、`leaderboard.mode.*`），
而且**已经漂移**：`mode.self.title` 写着「自测模式」，而 tab / 开始卡片 / 帮助都是「输入模式」→
**输入模式的设置浮层标题长期显示「自测模式」**。

现在：`MODE_SPECS` 每个模式一行（名字/帮助/计时测验/排行榜/粒度行/顺序行+默认顺序/搜索框/结算卡片/
非地图/两阶段/熟练度分析），派生谓词与类型**从表推导**：
- `LeaderboardMode` 由 `{ [K in Mode]: MODE_SPECS[K] extends { leaderboard: true } ? K : never }[Mode]` 推出，
  不再另写一份字面量联合；
- `MODE_SPECS` 写 `satisfies Record<Mode, ModeSpec>` → **新增 Mode 忘了加 spec 会 tsc 报错**；
- `help.<mode>.title` 这类键由模式名拼出，**表里说"有帮助"却没写文案也会 tsc 报错**（实测：
  第一版把 board/admin 也标了 `help: true`，tsc 直接指出 `"help.board.title"` 不是合法键）；
- `testButtonsVisible(mode, {started, board})` 把「跳过/暂停/重置」收敛成**一个纯函数**，逐模式真值表进单测。
  ⚠ 第一版把它写错了（以为无尽闯关没有重置），是**测试**把原语义纠正回来的 —— 语义清单见函数注释；
- 模式名统一走 `modeTitle(mode)`：删掉 `self/click/puzzle/endless.startTitle` 与 `leaderboard.mode.*` 共 8 个
  重复键，tab 文字由 JS 从表写入，`capabilities.test.ts` 断言 tab 兜底文字与 `modeTitle` 逐字一致。

### 3. `MapRenderer` 拆分（P0）

1,615 → **1,290 行**，拆出两个**可单测的纯函数模块**：
- `map/camera.ts`（306 行）：视图表（`DEFAULT_VIEWS`/`CONTINENT_VIEWS`/`SUBREGION_VIEWS`）、
  `viewFromBox`/`framingExtent`/`followZoomFor`/`defaultViewFor`/`provinceCamera`/`easeInOutCubic`；
- `map/series.ts`（275 行）：`buildGeoOption`/`buildTooltipOption`/`eventSeries`/`provinceLinesSeries`/
  `provinceLikeLabelSeries`/`cityLabelSeries`。

**故意没搬**（理由写在新模块注释里）：`wireChart*`（牵出约 10 处实例状态）、`buildSeriesOption`（数组顺序 =
渲染层序，且 `buildLineData()` 写 `lineBoxes` 的副作用在这一层可见）、`animateViewTo`/`focus*`/`pan*`/`flash`
（持有 ECharts 实例与 rAF）、标签状态机、以及十几个 1–3 行薄封装。
⚠ 搬 tooltip formatter 与标签 `renderItem` 时**必须传闭包而不是值**（`worldMode: () => this.worldMode`、
`scaleOf: () => labelScale(this.zoom)`）：ECharts 会在缩放/拖动期间反复调用它们，取快照会让首帧口径不一致、
缩放中字号卡住。

### 4. 测试夹具 `src/testCtx.ts`（P1）

`quizNaming.test.ts` 与 `browseLabels.test.ts` 各写了一份约 65 行的假 `ModeCtx`（含 `as unknown as ModeCtx`），
现已合并成一个 `makeTestCtx({data, showBrowseLabels, randomUnit})`（与 `testFixture.makeAppData` 同一手法）。

### 5. 验收脚本不再自带规则副本（P1）

`verify-naming.mjs` 的"去后缀省名"原先自己抄了一份后缀正则（且是死代码），改为读
`src/normalize-rules.json` 的 `provinceSuffixes` —— **规则类**事实从此只有一份；真值表类数据本来就已经从
`src/*.json` 读。抄一份的后果是：规则改了，验收会按旧规则"通过"。

### 验证

- `npm run check` exit 0（44 文件 / **514** 用例；本轮 +38：`naming.test.ts` 17、`capabilities.test.ts` 6→28）；
- 运行时 **214/214**：`verify-naming` 47/47、`verify-round3` 54/54、`verify-round2` 38/38、`verify-puzzle` 75/75
  —— 后三个同时是渲染器拆分的回归闸门（round2 覆盖跟随/取景，puzzle 覆盖画布与两阶段，round3 覆盖标签与按钮排版）；
- 删掉 8 个重复文案键后，tsc 把 5 个仍在引用它们的文件逐个点了出来（`click`/`endless`/`puzzle`/`leaderboardPanel`），
  这是"键即契约"的好处。

### 留给下次（P2，本轮刻意没动）

- `appController.ts` 748 行（DOM 接线 + 编排 + 榜单/留言板/Auth 胶水）：若还要拆，建议**跟模式目录一起动**
  （它的 32 处模式分支已消掉大半）；
- `ModeController` 12/37 个可选方法：目前还可读，再加 2 个模式就该换判别联合或能力位，而不是继续加 `?()`；
- 一个既有小怪癖（非本轮引入）：留言板/管理端的 `#mode-actions` 容器会显示但里面一个按钮都没有
  （`testButtonsVisible` 对非地图模式返回全 false，而容器的显隐条件是"非地图模式也显示"）。

## 本轮（2026-09）：标签按口径显示 + 省级「省会」档 + 国旗小图与"只缓存接下来两个"

用户三句话，三件事（都做完并验收）：

1. 「点击/输入模式下，未开始时地图标签按用户选的内容显示（选首都就标首都、选简称就标简称）」
2. 「省的分段按钮『省名/简称』加上『省会』」
3. 「地图上的国旗标签可以压缩，大幅减小体积；但点击模式题面卡片里的国旗不压缩（另外，不一次性全量缓存，仅仅缓存接下来两个国旗）」

### 1. 未开始的浏览标签按取名口径显示

- 落点：`RenderState.browseLabel?: (id) => { text?; image? } | null`（`src/types.ts`），由 `MapQuizMode.browseLabelContentOf()` 给出：世界档 → 国名/首都/英文名，或**国旗缩略图**；省级全国 → 去后缀省名/省会名/单字简称；地级档 → `null`（地级没有别的叫法，回落到单位名）。
- 渲染侧：`layers.browseLabelPoint()` 给三支中性标签（`showAllLabels` / `showAllProvinceLabels` / `worldShowAllLabels`）统一出数据；图片走 value 元组的**新增第 7 位**（`[lng, lat, text, color, isPrice, noBg, image]`），`labels.parseLabelValue` 因此把"文本为空就丢弃"放宽成"文本与图片都空才丢弃"——**不放宽就会把整档国旗标签静默丢光**（不报错、地图上什么都没有）。
- 图片标签在 zrender 里就是 `{ type: 'image', style: { image: url, x, y, width, height } }`：**字符串 URL 可用**，加载完自己调 `hostEl.dirty()` 重绘（`zrender/lib/graphic/helper/image.js`），**不需要**任何"图片就绪后再刷一次"的机制。外面套一张 `labelBg` 卡片 + `labelBorder` 描边：白底国旗（瑞士/日本/孟加拉）直接画在浅色地图上等于看不见。缩放下限 0.6（文字缩到 0.5 倍还能认，40px 的旗缩到 20px 只剩色块）。
- **已作答的绿/红标签仍按原口径写名字**（国旗档写国名）：那是答题反馈，得读得懂；只有浏览态才画旗。这条口径写在 `modes/types.ts` 的 `QuestionNaming` 文档里。

### 2. 省级「省会」档（三档：省名 / 省会 / 简称）

- 数据 `src/province-capital.json`（34 条）+ `province.ts` 的 `provinceCapital()` / `isProvinceCapitalInput()`，与 `province-abbr.json` 同一手法（静态口径表单独成 JSON，不重跑行政区数据管线）。判题接 `Matcher.normalize`，故「石家庄」与「石家庄市」都算对，而「河北」「冀」不算（与简称档同一"考什么就只认什么"原则）。
- **直辖市与特区的省会就是它自己**（京津沪渝港澳）：事实而非占位，不做特判 —— 特判会让省会档题库随行政体制变化"少几个省"，更难解释。`provinceCapital.test.ts` 专门断言这 6 条相等、其余 28 条必须不同（相同即漏表回落成省名）。
- 输入模式也提供（用户口径）：占位提示 `self.provinceCapitalPlaceholder` = 输入省会名。

### 3. 国旗：标签用 40px WebP 小图，题面仍用原始 SVG，且只预取接下来两道

- 新管线 `scripts/build-flag-thumbs.mjs`：无头 Edge + CDP 把 194 面 SVG 逐张画进 40×30 canvas、`toDataURL('image/webp', 0.85)`，写出 `public/data/flags/thumbs/*.webp` + `thumbs.json`。**实测合计 163KB**（原始 SVG 1.21MB，小约 87%；中位 814 字节、最大 1KB）。与 `index.json` 是两张表、各自单一职责；`worldFlagsData.test.ts` 断言键集合逐字相同、文件存在且**真的是 40×30 WebP**（读 RISFF/VP8 头解析宽高，防止哪天有人把原图拷进来）。
- **预取从"整池 194 面"改成"当前题 + 接下来两道"**（用户口径）。难点：点击模式的下一题是答对那一刻才随机/按分数选的，不提前定下来就无从知道该缓存哪两面。于是 `ClickMode.lookahead` 把选题**提前一步**：
  - 正确性论证（写在 `click.ts` 的类内文档里）：**错题顺序**下分数只在被作答时改变、被作答就离开池子 → 剩余池的排序在预选与消费之间不可能变 → 预选结果与届时重选**逐字相同**；**随机顺序**下池子相同、均匀抽取 → 分布相同，只是抽签提前一次。预演**绝无副作用**：`pickWrongNext` 唯一的副作用是弹"错题已出完"，故传状态副本 + 空提示函数。
  - 消费时仍按 adcode 重新校验是否还在池内，不在就当场重选（换池/重置会清空预选）。
  - 新计划**保留仍然有效的旧预选**再补足到两道：否则每题都把下一题的抽签重来一次，上一次预取的那张图白取（等于每题多请求一张）。
  - 首题也要规划：`start()` 里 `onStarted(first)` 先播种，再 `ask(first)`，**最后**才 `syncFlagPreload()`（顺序反了队列里的"下一题"就是旧的，新题仍要等网络）。
- 实测（`verify-naming.mjs` 第 6 节，真实浏览器的 `performance.getEntriesByType('resource')`）：未开始时**一次国旗请求都没发**（旧版是 194 面）；开始瞬间恰好 3 面在队、网络 3~4 面；**每换一题只多 1 面**，且新题那一面在换题前就已请求。缩略图标签 193 张 + 1 行已作答国名，`naturalWidth/Height` = 40×30。
- 顺手修掉一个探针能看到的真 bug：`flagPreload` 的 `inFlight` 在换池时被重置，而旧队列已发出的请求回调仍会跑 → **计数变负**（探针实测 `inFlight: -1`，并发上限因此形同虚设）。加 `generation` 代次：旧回调识别出代次已变就只返回、不再减。

### 验证

- `npm run check` exit 0（43 文件 / **475** 用例；本轮 +25：`provinceCapital.test.ts` 7、`quizNaming.test.ts` +14、`labels.test.ts` +4、`worldFlagsData.test.ts` +4、`browseLabels.test.ts` +1，另有多处随口径更新）。
- 运行时：`verify-naming.mjs` **47/47**（本轮 30→47）、`verify-round3` 54/54、`verify-round2` 38/38、`verify-puzzle` 75/75 = **214/214**。
- ⚠ `quizNaming.test.ts` 现在还要 stub `localStorage` 与 `window`（`start()` 会碰秒表与进度记忆），并 `resetFlagPreloadForTest()` 复位模块级 `done`/代次。

### 留给下次

- **每次答对后的地图重绘 ≈120ms**（本机实测，与国旗无关）：`answer()` → `renderer.flash()`（setOption geo.regions + 裁剪）→ 900ms 后再整幅 `render()`。若用户仍觉得"换题有一顿"，该优化的是这里（例如 flash 只改 region 不重建 option）—— 在国旗上已经无可优化（每换一题只 1 个 1KB 请求）。
- 国旗档的已作答标签写国名，与浏览态的旗是两种表达，这是刻意的；若将来想统一成旗，需要先回答"绿色/红色怎么画在旗上"。

## 本轮（2026-09）：国旗预加载 —— 消掉"每换一题等 0.5 秒"

> ⚠ 本节的**预取口径已被上一轮取代**：现在是"当前题 + 接下来两道"（用户新口径），不再是整池 194 面。
> 下面的测量数据与"下一题无法预知"这个约束的论证仍然有效，实现细节（队列来源、挂钩点）请以上一轮为准。

用户报「每次地图都会加载 0.5 秒」。**先量再改**（临时探针：空缓存 profile 下逐题记「出题 → 国旗真的画出来」）：

| 题次 | 出题→可见 | 该请求耗时 | 答对后地图重绘 |
|---|---|---|---|
| 1（冷缓存） | 32ms | 15ms | 121ms |
| 2~6 | 0ms | 2~5ms | 119ms（平均） |

结论：**本机国旗几乎不花时间**（第 1 面 32ms、之后 0ms，延迟来自网络而非解码），而**每换一题都有一次地图重绘 ≈120ms**（ECharts，`answer → flash/setOption → render`）。线上慢网下每面新国旗是**一次独立网络请求**（每题一个文件、缓存未命中）→ 那才是 0.5 秒的来源，用户的诊断是对的。

### 关键约束：点击模式的"下一题"无法预知

`answer()` 里才 `this.ask(this.nextUnit(pool))`，而 `nextUnit` 是**随机**（或错题按分数）—— 所以"预加载后面那一面"根本不知道加载哪一面。
唯一能让每面国旗都零延迟的做法：**预取当前出题池的全部国旗**（用户 2026-09 口径：全预取，不看 `saveData`）。

### 实现

- 新增 `src/modes/flagPreload.ts`：模块级队列，**3 并发、低优先级**，逐个 `new Image()`（同源静态 SVG，一次普通 GET 即进 HTTP 缓存，不需要 decode、不入 DOM）。
  - `preloadFlags(srcs)` 替换队列（调用方给的顺序即优先级）；`done` 集合避免对同一 src 反复建 Image；
  - 单张失败（404）**不阻塞队列**、不重试（重试交给下次换池）—— 否则一次网络抖动会让整池永远取不完；
  - `stopFlagPreload()` 清队列（已发出的请求不可回收）；`flagPreloadStats()` / `resetFlagPreloadForTest()` 供探针与测试。
- `MapQuizMode` 挂钩点：`setQuestionNaming`（**一选上国旗档就开取**，符合用户原话）、`enter()`、`onViewChange()`（下钻/返回换池）、`answer()` 里 `ask()` 之前（当前题优先）；`exit()` 停队列。
- 池子顺序 = 当前题（若有）→ `activePool()`；`flagSrcOf()` 统一了"iso → `data/flags/<文件>`"这一处拼路径（原来 `worldFlagSrc` 自己拼，现在共用）。
- **题面卡片不做"等图就绪"**（用户口径）：卡片尺寸固定（高 112px）不会跳动，预取生效后基本看不到空框。

### 验证

- 单测：`flagPreload.test.ts` 7 例（并发上限 3、完成即补位、**失败不阻塞**、同池不重发、换池替换、stop 后不再发、去重）；`quizNaming.test.ts` +2（选上国旗档立刻开取整池、切回国名档停队列）。⚠ 该测试现在需要 stub `Image`（node 没有），并 `resetFlagPreloadForTest()` 复位模块级 `done`，否则测试之间会串。
- 运行时 `verify-naming.mjs` +2：**实测预取到 194 面且 initiatorType 全是 `img`**、当前题的旗在预取集合里。⚠ 过滤器要排掉 `data/flags/index.json`（那是 `data.ts` 用 fetch 拉的索引，initiatorType 是 `fetch`，会把计数多算 1、也会让"全是 img"的断言假失败 —— 我第一版就是这么错的）。
- 合计：`npm run check` exit 0（42 文件 / 445 用例）；运行时 verify-naming 30/30、verify-round3 54/54、verify-round2 38/38、verify-puzzle 75/75 = **197/197**。

### 留给下次的性能项（本轮没动）

- **每次答对后的地图重绘 ≈120ms**（本机实测，与国旗无关）：`answer()` → `renderer.flash()`（setOption geo.regions + 裁剪）→ 900ms 后再整幅 `render()`。若用户仍觉得"换题有一顿"，该优化的是这里（例如 flash 只改 region 不重建 option），而不是继续在国旗上找。
- 预取的 1.2MB 在移动网络下是实打实的流量（用户明确选择不看 `saveData`）；若将来要改，只需在 `flagPreload.preloadFlags` 调用点按 `navigator.connection` 截断 `srcs` 长度。

## 本轮（2026-09）：按钮顺序再修订（粒度行回到范围行之上）+ 点击模式「国旗」档

### 1. 未开始按钮顺序（第二轮修订）

上一轮把「世界/省级/市级」放在大洲/次区域行**下面**，用户看过之后要求改回**上面**（先选粒度、再选该粒度下的范围）。
定稿顺序（只影响未开始态，开始后一字不变）：

```
顺序/随机/错题 · 国名/首都/国旗 · 中文/英文 …   ← 状态与题面口径行
世界 / 省级 / 市级                              ← 粒度行（在更细的范围行之上）
全世界 / 各大洲
次区域（全亚洲 · 东亚 …）
重置                                           ← 仍独占最后一行
```

实现是纯 `index.html` 的 DOM 位移：`#granularity-break` + `#granularity-toggle` 移到 `#continent-break` **之前**；
`#reset-break` + `#btn-reset` 仍在末尾。chromeSync 的显隐规则与占位语义都没改（`#granularity-break` 跟粒度行显隐、
`#reset-break` 只在 `(isTestMode || isPuzzle) && !testStarted` 显示），所以开始后的布局仍是逐像素不变。

### 2. 点击模式「国旗」档（新功能）

- **口径**：世界档那句「国名 / 首都」加第三段 **国旗**，**只在点击模式出现**（输入模式没有"看图点地图"这条路）；
  题面在上方给一张国旗图，用户点地图上对应的国家；**地图标签仍显示国名**（语言开关照常生效）；题面 `alt=""`、
  卡内无任何文字 —— 不能把答案写在题面上。缺该国国旗资源时**回落成国名题面**（宁可是文字题，也不要破图/空白）。
- **数据**：`scripts/fetch-world-flags.mjs` → `public/data/flags/index.json`（`iso_a3 → 文件名`）+ 194 个 SVG（**原样复制**，
  合计 1.21MB）。源：**flag-icons v7.5.0（MIT）** 的 `flags/4x3/<a2>.svg`，经 jsDelivr；a3→a2 映射取 Natural Earth
  v5.1.2 `_chn`（与 `world_names.json` 同一份源与同一套 `-99` 判定）。实测 194 国的 a2 **全部**可从源取到，
  故 `A2_OVERRIDES` 例外表目前为空；脚本对"取不到 a2"是**硬失败**（不许静默留空）。
- **为什么不用 emoji 国旗**：Windows 的 Chrome/Edge 不渲染区域指示符对（🇯🇵 会显示成「JP」），而本项目的开发与
  运行时验收都在 Windows 上 —— emoji 方案连验收都过不了。这是选 SVG 资源、并付出 1.21MB 体积的唯一理由。
- **代码**：`QuestionNaming.world` 增 `'flag'`（`namingStore` 校验同步）；`worldDisplayName()` 把 flag 当国名（标签与答错提示
  都用国名，旗帜在提示里也放不下）；新增 `worldFlagSrc()`；`click.ts` 的 `showQuestionHint` 分支渲染
  `<img class="flag-question">`；`chromeSync` 按模式隐藏 `#world-name-flag`；`styles.css` 新增 `.flag-question img`
  （高度固定 112px、宽度随比例 —— 含瑞士这类方形旗与尼泊尔这类非矩形旗；白底 + 描边，白旗才看得见）。
- **数据是硬依赖**：`data.ts` 会加载 `data/flags/index.json`。**它缺失时整个应用启动失败**（不是"国旗档不可用"）——
  与 `world_names.json` 同一策略：数据文件缺失要**响亮地失败**，不要静默降级。本轮实测踩过一次：
  资源还没生成时跑 verify-round3，脚本里的静态 DOM 断言"假通过"、JS 驱动的断言全失败，根因就是 boot 失败。
- **测试**：`worldFlagsData.test.ts`（键集合与 `countries.json` 双向一致、每个被引用文件存在/非空/确实是 SVG、
  无孤儿文件、source 写明许可）；`quizNaming.test.ts` 增 4 例（题面是国旗且不含国名、alt 为空、标签显示国名、
  缺资源回落、英文档标签用英文名）；`namingStore.test.ts` 增国旗档持久化。运行时 `verify-naming.mjs` 增 6 条
  （含**「图片真的加载出来」**：量 `naturalWidth/naturalHeight` —— 只断言 `src` 正确是证明不了资源存在的）。

### 验收

- `npm run check` exit 0；vitest **41 文件 / 436 用例**（本轮 +9）。
- 运行时：`verify-round3` **54/54**（布局 7 条几何断言按新顺序修订）、`verify-naming` **28/28**（+6 国旗）、
  `verify-round2` 38/38、`verify-puzzle` 75/75 —— 合计 **195/195**。
- 国旗管线重跑幂等（第二次全部命中缓存，`index.json` 逐字节相同）；报告：合计 1.21MB、中位 1KB、
  最大 5 个 SRB 177KB / BOL 100KB / MEX 83KB / ESP 79KB / SLV 75KB。

## 本轮（2026-09）：未开始的按钮纵向布局 —— 重置恒在最下面

用户口径（四轮澄清后定稿，只改**未开始**态，**开始后的布局一字不动**）：

```
顺序/随机/错题 · 国名/首都 · 中文/英文 …     ← 状态与题面口径行（其余全都不动）
全世界 / 各大洲                            ← 下钻行（仅世界粒度）
次区域（全亚洲 · 东亚 …）                   ← 下钻行（仅该洲有分区时）
世界 / 省级 / 市级                          ← 粒度行
重置                                       ← 始终独占最后一行
```

- **实现**：`index.html` 里把 `#granularity-toggle` 从 `#mode-actions` 的**头部移到末尾**（大洲/次区域行之后），
  `#btn-reset` 排在其后；新增两个只在未开始可见的换行占位 `#granularity-break` / `#reset-break`
  （`flex-basis:100%` 的零高 div，与既有的 `#continent-break`/`#subregion-break` 同一机制）。
  `chromeSync.syncSegments()` 决定它们何时隐藏：`#granularity-break` 跟着粒度行显隐（无尽未开始没有粒度行，
  两个占位同时可见会多出一个空行），`#reset-break` 仅在 `(isTestMode || isPuzzle) && !testStarted` 时显示。
- **为什么不用 CSS `order`**：换行占位必须跟着元素一起换位，`order` 会让占位与按钮脱节；而且
  `flex-basis:100%` 加在分段按钮条上会把按钮组拉伸到屏宽（既有注释里已记过这个坑）。
- **为什么开始后不受影响**：开始后粒度行/大洲行/次区域行整组收起，两个新占位也跟着收起，
  于是 `跳过 · 暂停 · 重置` 回到同一行 = 与改动前逐像素相同（运行时实测同一 y）。
- **边界**：熟练度分析（free）没有"开始"，不在这条规则内 —— 它用的是另一个元素
  `#analysis-granularity-toggle`（留在原位），故其粒度行仍与重置同行（用户明确要求保持不变）；
  留言板/管理端没有这些行，占位也跟着隐藏。
- **验收**：`scripts/verify-round3.mjs` 新增 7 条**几何断言**（量 `getBoundingClientRect()`，不靠看图）：
  世界档四行严格递降且 x 全部 = 16（左对齐）；市级档两行递降；开始后 `跳过·暂停·重置` 同一 y 且 x 递增；
  两个占位在开始后收起；重置回开始状态后回到两行。实测：大洲 y=133 → 次区域 190 → 粒度 243 → 重置 300。
- 另修掉 `verify-naming.mjs` 的一处**假失败**：「题面不是国名」原先用 `includes()`，而
  巴西利亚/墨西哥城/巴拿马城 这类首都名**包含国名**，随机首题抽到巴西就假失败 —— 改为全等判断。
- 验收合计：`npm run check` exit 0（40 文件 / 427 用例）；运行时 verify-round3 **54/54**、verify-round2 38/38、
  verify-puzzle 75/75、verify-naming 22/22 = **189/189**。

## 本轮（2026-09）：留言板草稿不再丢 + 取消自由模式（浏览标签并入四模式）+ 游客登录入口

三件事都来自用户报的现象，前两件是产品变更、第三件是缺陷。

### 1. 留言板：未登录写完点发布，登录/注册后**直接发布**（草稿不再丢）

**缺陷有两处**（只修一处都还会丢内容）：
1. `submitPost()` 未登录时直接 `return` —— 草稿**只存在于 DOM 输入框里，从未被抓取**；
2. 登录成功回调是 `this.render()`，而 `render()` 会 `el.innerHTML = …` **重绘整个面板**，DOM 连同输入框内容一起作废。

**现在的做法**（与排行榜提交成绩早已在用的 `ScoreSubmitter` 同一套路「未登录先挂起、登录后自动补交」对齐）：
- 先取内容 → 未登录则 `authPanel.requestLogin(() => publishPost(content))` → 登录/注册成功（`completeSuccess` 两条路径共用）自动发布，用户不必重写；
- 草稿**随打随存**在 `localStorage`（`src/ui/boardDraft.ts`，键 `china-admin-board-draft-v1`）：放弃登录、切模式、刷新页面都不丢；**只有发布成功才清空**（用户口径）；
- 回复同样处理（内容捕获 + 登录后续发；失败则保留回复框与内容）；删除**不**自动续做（破坏性操作让用户再点一次）；
- 发布失败会把内容回填进输入框并提示。
- ⚠ **`try` 只包住网络调用**：早先写成「try { createPost; clearDraft; render; toast }」，于是渲染或提示抛错会被当成"发布失败"而把草稿又存回去 —— 用户会以为没发出去，再点一次就**重复发帖**。改动后是 `try { createPost } catch {…} clearDraft(); render(); toast()`。

**测试**：`src/ui/boardPanel.test.ts` 用一个**模拟真实重绘语义**的假 DOM（`innerHTML` 赋值即作废此前的子元素，与浏览器一致）——旧实现在这套测试下会挂在「登录后输入框空了 / `createPost` 从未被调用」。另有 `boardDraft.test.ts`（存储契约）与运行时验收两条（见下）。

### 2. 取消「自由模式」：浏览标签并入前四个模式

- 第 5 个标签页与 `FreeBrowseMode`（`memory` 模式）**整体删除**（不是留着不接线）；`Mode` 联合类型、`chromeSync` 的四处分支、`capabilities` 表、`modeSettings` 的旧开关一并清理。id 删除为何安全见 **ADR 0001 的 2026-09 补记**。
- 口径（用户逐条确认）：**未开始显示全量地名**（与自由模式逐字一致：阈值 0，任何倍率都显示）→ **开始答题后收起**（只收浏览标签，已作答的绿/红**保留**）→ **结束（结算卡片出现 / 答完 / 重置）后复现**；**暂停不算结束**。
- 粒度决定显示哪一层：世界=国名、省级全国=省名、**其余（含省级全国下钻某省）=地级市名**（浏览的是"画面上现在有什么"）。
- 无尽闯关：未开始显示地名，开始后回到自己的价格/已收集显示；**拼图不改**（名称由难度档说话，困难档刻意不给提示）。
- 实现：`src/modes/browseLabels.ts`（片段工厂）+ `MapQuizMode.browseLabelState()`（`started && !settled` 时才给）+ `ModeController.onSettlementShown?()`（外壳在弹结算卡片后调用，把这次会话记为"已结束"）。全局开关 `Settings.showBrowseLabels` 落在导航栏「设置 → 地图标签」，默认开。
- **旧键迁移**：老用户若在自由模式里关过标签（`china-admin-memory-hide-labels-v1` = `'1'`），新开关初值取反 → 保持关闭；`china-admin-mode-granularity:memory` 直接丢弃。见 `src/store.test.ts`。
- ⚠ **顺手修掉一个真缺陷**（运行时验收抓到的）：`buildWorldLabelData` 原来在 `state.worldLabel` 分支里 `return out`，而点击/输入模式**永远**会传 `worldLabel` —— 于是世界档未开始的国名标签被整段吃掉（省级/地级两档正常，所以肉眼很难发现）。现在已作答的保留绿/红、其余补中性色，并有 `layers.test.ts` 的回归闸门。

### 3. 游客点右上角进不去登录界面（缺陷）

`authPanel.renderMenu()` 在未登录时把「个人资料 / 修改密码 / 退出」**全部置为 disabled**，而 `#user-center` 的点击只负责展开菜单 —— 于是游客点右上角后**一项都点不动**，也没有别的入口（按钮文案却写着「点击登录」）。现在：游客点右上角**直接打开登录卡片**，菜单只对已登录用户展开。

### 验收

- `npm run check` **exit 0**；vitest **40 文件 / 427 用例**（本轮新增 `boardPanel` / `boardDraft` / `browseLabels` / `store` 四个测试文件）。
- 运行时：`verify-round3` **46/46**（新增 8 条：模式页签只剩四个、三档未开始的浏览标签、开始后清空且已作答保留、结算卡片即复现、关卡片后仍在、全局开关关/开、游客点右上角进登录、未登录发帖草稿落本地）；`verify-round2` 38/38、`verify-puzzle` 75/75（页签断言已更新）、`verify-naming` 22/22 —— 合计 **181/181**。
- 写验收脚本时的两个注意点：① `#btn-reset` 是**二次确认**按钮，要点两次；② 省级/世界全国进行中点重置会**弹结算卡片**（这正是"结算即复现"的验收点），**验完必须点 `#settlement-close` 收掉** —— 否则后面那条"按钮文字对比度 ≥3.5:1"的客观体检会扫到卡片里的白字绿底按钮（1.92:1）而失败。那个对比度是**既有**问题，不是本轮引入（卡片一直存在），要改属独立一轮。

## 本轮（功能）：取名口径 —— 世界档「国名/首都」+「中文/英文」、省级全国档「省名/简称」

用户需求要点：世界模式下（输入 / 点击）在「随机/错题」右边加「国名/首都」，选首都时按首都名出题**且地图标签也显示首都名**；再往右加「中文/英文」，切换**顶部出题框与地图标签**的语言（UI 交互仍只用中文）；省级全国模式下右侧加「省名/简称」，选简称后按单字简称（沪）出题、标签也显示简称，**省级档不加中英文按钮**。

### 数据（两个新文件，都是可重生成的冻结产物）

| 文件 | 内容 | 生成方式 |
|---|---|---|
| `public/data/world_names.json` | 194 条 `iso → { en, capital, capitalEn }` | `node scripts/fetch-world-names.mjs` |
| `src/province-abbr.json` | 34 省 `adcode → 单字简称`（另有 5 省的官方并存写法 `alt`） | 静态表，无需生成 |

- 世界数据源与仓库既有几何管线**同源**：Natural Earth v5.1.2（公有领域）—— 国家英文名取 `ne_10m_admin_0_countries_chn` 的 `NAME_EN`，首都取 `ne_10m_populated_places` 里 `ADM0CAP=1` 的据点。**为什么单独一张表而不并进 countries.json**：那条几何管线的输出契约被 lib 与探针逐字依赖（见 `fetch-world-data-v2.mjs` 顶部「一行不改」的口径），语言/首都属于可独立重建的另一类事实。
- 脚本重跑幂等（连跑两次 sha256 相同，无时间戳）；人工校订全部收在 `NAME_OVERRIDES`（31 国、38 处改动，每条带中文理由），末尾打印 before→after 供审计。**源数据并不干净**：5 条繁体字（三蘭港/維多利亞/馬拿瓜/瓜地馬拉/培亞）、3 国源里连不到首都（NRU/PSE，以及实测发现的 SSD —— 两个源的 `ADM0_A3` 不一致、Juba 的 `ADM0CAP=0`）、14 条台湾译名（京斯敦/摩加迪休/嘉柏隆里…）、1 条过时地名（KAZ 仍是努尔苏丹，2022 已改回阿斯塔纳）。
- `src/worldNamesData.test.ts` 断言两侧 iso **集合完全一致**、三字段非空、无繁体残留、source 写明来源。少一条的表现是「某国首都题永远显示国名」，只在点开地图时才发现 —— 故必须逐条断言。
- 省份简称单独成表而不加进 `units.json`：它是**判题与显示口径**（与 `normalize-rules.json` 同类），不是几何；`provinceAbbr.test.ts` 断言它的 adcode 集合与真实数据的 34 个省一致、简称互不重复、且每个简称确实是单字。

### 代码落点（口径只允许有一个来源）

- 状态：`modes/types.ts` 的 `QuestionNaming { world, lang, province }` + `ModeController.getQuestionNaming/setQuestionNaming`；持久化在 `modes/namingStore.ts`（**逐字段**回落默认，一个字段写坏不牵连另两个）。
- **`MapQuizMode.displayNameOf()` 是题面（点击模式题卡）、地图标签、答错提示三处的唯一名字来源** —— 三处若各拼一份，就会出现「题卡写首都、标签写国名」这种自相矛盾的界面。省级档例外一处：标签历史上就是去后缀省名（广东省→广东）而题面是省全名，故另开 `provinceLabelTextOf()`，「简称」档两者统一成单字。
- 守卫在模式层：`setQuestionNaming` 在 `started` 时直接返回（UI 侧这些行也开始后收起，但守卫下沉到代码，免得将来某条路径绕开 UI）。
- UI：`index.html` 三组 `mode-segmented`（`#world-name-toggle` / `#world-lang-toggle` / `#province-name-toggle`），显隐与高亮由 `ChromeSync.syncNamingRows()` 按「模式 + 粒度 + 是否已开始」算（`syncSegments` 因此超了 ESLint 的 60 行上限，顺手拆出该方法）；接线在 `appController.wireScopeToggles`，只改口径不改范围，故**不走** `afterScopeChange`。
- 输入框占位提示跟着口径走（`self.capitalPlaceholder` / `self.abbrPlaceholder` / …）：口径变了提示不变，用户不知道该输入什么。

### 判题口径（有意的「宽严两套」，别当成不一致）

- **改的是考什么 → 严格**：国名档只认国名、首都档只认首都名、简称档只认简称（不认省名）。理由：简称档若同时接受「上海」，不记得「沪」的人也能过关，这一档就白开了；与 `Matcher.bestUnit`「不做模糊匹配」同一原则。
- **中/英文是同一个名字的两种写法 → 两种都接受**：语言开关只换显示文字，不改变"考什么"。
- **首都档不走 `bestMatch` 的「重名剔除」，改用 `acceptsCapital(iso, input)`**（重要！）：判据本来就该是"这个输入是不是**当前这一题**的合法名字"。沿用国名档的剔除会造成真实死角 —— 牙买加 Kingston 与圣文森特 Kingstown 的**大陆通用译名同为「金斯敦」**，两边都被剔掉后这两国在「首都 + 中文」下**永远答不出来**（`worldNames.test.ts` 有回归闸门）。国名档仍保留剔除（刚果（金）/刚果（布）剥后缀同名的「刚果」两国都不接受），因为数据侧本来就给了带括号的消歧写法、且该决策有既有测试。
- 首都接受名另有别名表 `WORLD_CAPITAL_ALIASES`：数据侧取一个（如 ZAF 比勒陀利亚、BOL 苏克雷、BEN 波多诺伏），另一说（开普敦/拉巴斯/科托努）与"同城异名"（华盛顿、海牙、多多马、拉姆安拉、恩吉鲁穆德）都接受。国家英文名同理有 `WORLD_EN_ALIASES`（United States / UK / Gambia / Bahamas…）。

### 验收

- `npm run check`（两套 tsconfig + ESLint + 单测）**exit 0**；vitest **37 文件 / 392 用例**（此前 37 / 350）。
- 运行时：**新增** `scripts/verify-naming.mjs` **22/22**（三组按钮按粒度显隐、世界首都/英文的题面与**画布标签**、省级简称、省名档历史口径回归）；既有 `verify-round2` **38/38**、`verify-round3` **38/38**、`verify-puzzle` **75/75** —— 合计 **173 项全过**。
- 新增探针方法 `quizProbe.namingTexts()` / `answerCurrent()`（读顶栏题面 DOM + 两条标签系列**实际会画出的文字**）与 `uiProbe` 的 `labelTexts`：验收脚本拿数据文件当真值比对，而不是"看起来像"。探针的 `QuizSessionDiagnostics` 补了 `naming`（可读写）与 `started` 的 setter，用于构造「已开始」场景。

### 两个坑（下一个人别再踩）

1. **不要用 PowerShell 的字符串替换改含中文的源文件**：`Get-Content -Raw` + `-replace` + `Set-Content -NoNewline` 会把 UTF-8 写坏（实测把一个测试文件的「上海市」写成乱码，且随后文件工具因「invalid UTF-8」拒绝读它，只能删掉重写）。改写用文件工具，别走 shell 管道。
2. 数据子代理（Natural Earth 两条源的连接、繁体/台湾译名、多首都取舍、源缺失）值得单独交出去做：它额外找出 3 条繁体字、SSD 与 KAZ 两处源问题，是主线实现时容易漏掉的量。但**它的输出必须自己复核**：本次复核就发现「JAM/VCT 同形首都名会让两国答不出来」这条它会 WARN 但不会修 —— 那是消费端的判题逻辑问题，属于主线。

## 本轮（重构 P5）：按收益排序的五项收敛 + 一处顺手发现的判题口径问题

体检口径与前面几轮一致（耦合 / 可读性 / 可维护性）；结论是**没有新的结构性病灶**，
剩下的收益全在「散落的重复」与「只能靠手测的纯逻辑」这两类上。按收益排序做了五项：

### 1. `authPanel.ts` 的纯逻辑搬出面板（收益最高：619 → 478 行）

新增 `src/ui/hometown.ts`（82 行）与 `src/ui/avatarImage.ts`（56 行），**+23 个单测**。

为什么这是最高收益项：那 160 行是「用户输入的『广东』到底对应哪个 adcode」的领域规则 ——
结果会写进 D1、再显示在排行榜上（写错就是永久错），却因为长在面板类里只能靠浏览器手测。
`compressAvatar`（canvas 压缩阶梯）同理。抽出后：

- `resolveHometown` 用**可辨识联合**返回 `empty / invalidProvince / invalidCity / ok`，
  面板只按类别选 i18n 文案，测试只断言类别；比原先「返回 `UserHometown | null | Error`」好断言得多。
- 口径被单测锁住：省市必须同时填（只填省 = `invalidCity`）、跨省拒绝、装饰面 `100000_JD` 不当城市、
  空输入返回 `empty`（合法，不清掉草稿）。

### 2. 开始卡片 4 处重复 → `ui/dom.showStartCard`

输入 / 点击 / 无尽 / 拼图各抄了一份逐字相同的 `start-panel` HTML + 按钮接线，其中**三份**还用
`setTimeout(…, 0)` 去取按钮 —— 但 `setHint` 是同步写 innerHTML 的，那个延时纯属多余
（白多一个宏任务，也让「点开始没反应」更难查）。现在四处都只剩一次 6 行的调用。
注意拼图那边的私有方法因此改名 `renderStartCard`，避免与方法名同名的导入函数混淆。

### 3. 模式能力表 `src/modes/capabilities.ts`（新增，防「新增模式漏改一处」）

三组集合原先以谓词链的形式散在 `appController`（排行榜资格）与 `chromeSync`（侧栏、按钮显隐、搜索框）**4 处**，
只靠注释提醒「与 xx 保持一致」：

| 集合 | 含义 | 原先出现在 |
|---|---|---|
| `LEADERBOARD_MODES` | 有排行榜 / 可提交 | appController ×1、chromeSync ×1 |
| `TIMED_TEST_MODES` | 有 开始/暂停/跳过 生命周期 | chromeSync ×2 |
| `GRANULARITY_MODES` | 拥有「世界/省级/市级」粒度行 | chromeSync ×1 |

新增模式（拼图就是这么加的）漏一处的表现是**静默的 UI 不一致**（按钮显示但功能没接上），不是编译错误。
`LeaderboardMode` 类型也改为由运行期表推导（`typeof LEADERBOARD_MODES[number]`），
`leaderboardStore.ts` 转出以保持既有导入路径。`capabilities.test.ts` 断言前端集合与服务端
`validMode` 白名单**逐项一致**（与 `subregions.test.ts` 断言前后端哨兵同一手法）。

### 4. 无尽的两个价格开关并入 `modeSettings.ts`

`endless.ts` 尾部手写的 4 个 localStorage 函数（各自带一份 try/catch）与 2 个键常量删除，
改走该文件已有的 `loadBool/saveBool` —— 全仓其它模式的开关都在 `modeSettings.ts`，只有无尽在外。**-60 行**。

### 5. `appController` 悬停卡片三处重复 → `showHoverCard`

世界 / 省级 / 地级三档取名字与熟练度的方式不同，但卡片本身（`t('main.hoverStatsProvince', …)` + 档位词 + 显示）
原先逐字抄了三遍。

### 顺手发现的口径问题（**没有改**，留给作者决定）

`matcher.normalize` 的 `while` 循环会**反复**剥后缀，于是 `广州市 → 广`、`徐州市 → 徐`、`苏州市 → 苏`。
实测 `public/data/units.json` 的 373 个地级单位里有 **43 个（11.5%）**规范化后只剩单字；
而 `Matcher.bestUnit` 的判据是 `ni === r.nf`，所以**输入模式下单字「广」会被判成「广州」正确**。

- 这是 `normalize` 的既有语义（`matcher.test.ts` 只覆盖了 `北京市 → 北京` 这类单次剥离），**不是本轮引入的**；
  本轮只是把它的后果写进了 `hometown.test.ts` 的一条用例里。
- 未改原因：这是**判题口径**，不是重构。`normalize` 同时被判题（`Matcher`）、家乡匹配、排名共用，
  收紧它可能挡掉本来想要的简写容错（「苏」对苏州算不算对？）—— 需要先定口径。
- 若要收紧，最小改法是「后缀只剥**一次**」：`北京市 → 北京` 不变，`广州市 → 广州`（不再是「广」），
  再补 `matcher.test.ts` 的用例。改动会影响所有依赖 `normalize` 的判题路径，**别顺手做**。

### 验收

- `npm run check`（两套 tsconfig + ESLint + 单测）**exit 0**；vitest **33 文件 / 350 用例**（此前 30 / 321）。
- 运行时：`verify-round2` **38/38**、`verify-round3` **38/38**、`verify-puzzle` **75/75** ——
  **151 项全过**，其中覆盖了本次改动的开始卡片接线（含拼图开始卡片）、排行榜侧栏的收起/展开、模式分段行显隐。
- 本机提醒（沿用上轮结论）：跑运行时验收前若怀疑读到旧产物，用 PowerShell 清 `dist`
  （`Remove-Item -Recurse -Force dist`），node 的删除在本机被静默拦截。

## P4（工程守卫 + 后端收口）

### 加了什么

- **ESLint（`eslint.config.js`，平铺配置）** + `npm run check`（类型检查两套 tsconfig + lint + 单测）+ `.github/workflows/ci.yml`。
  规则只挑「真实踩过的问题」：`no-unused-vars`（本轮搬文件后有 3 处导入静默失效，当时靠手写脚本才发现）、
  `max-lines-per-function` / `max-lines`（防止刚砍下去的长函数长回去）、`no-explicit-any`（全仓 0 处，锁住它）、
  `no-console`、`eqeqeq`、`prefer-const`。上线首轮跑出 **9 处真实死代码**（全是历史遗留，含 6 个 `.cnatlas-tmp/` 一次性脚本被误纳入 lint 范围 —— 已在 ignores 里排除）。

- **`functions/_lib/profile.ts` + `profile.test.ts`（14 个用例）**。原先「个人资料」接口的字段校验内联在
  `api/auth/profile.ts` 的 79 行 handler 里，**没有任何测试**，而它们做的是安全相关的检查（头像两个体积上限、
  家乡 adcode 格式、改密码时的旧哈希比对）。按 `_lib/board.ts` 的既有做法抽出来后可单测。
  路由文件从 118 行降到 55 行，handler 从 79 行降到 30 行。

- **`validateScore` 拆成三段**（`normalizeScope` / `readScoreNumbers` / `assertSubmittable`），67 → 25 行。
  **24 个既有单测全过**是这次重构等价性的凭据。`cullToViewport` 同理拆出 `cullFaces` / `cullLines`，64 → 22 行。

### 为什么**没有**引入 Prettier（重要，别重复踩）

试过，实测它会推翻本仓库两处**刻意且一致**的约定：

| 约定 | 现状（约 20 个文件一致） | Prettier 会改成 |
|---|---|---|
| D1 链式调用 | `prepare(...)` ⏎ `.bind(...)` ⏎ `.run()` 三行 | 挤成一行，**且只在整条 ≤140 列时才挤** → 同仓库两种写法并存 |
| 紧凑单行方法 | `enter() { void this.panel.show(); }`（appController 的 9 个 chrome 委托也是） | 一律展开成 4 行 |

全仓 71 个文件需要重写，diff 会埋掉重构历史，收益不抵。ESLint 是**只报不改**的，适合做回归守卫。
如果你确实想要 Prettier，那是一次独立的、需要先跟作者确认版式的改动。

### 顺手修正的一处错误判断

上一轮我在体检报告里写「`functions/api/auth/profile.ts` 的 `requireSession` 有 91 行，是端点间重复的
鉴权样板」——**这是错的**。那个 `requireSession` 是 `_lib/guard.ts` 的导入封装，鉴权样板早就抽好了；
91 行是我的「最长函数」探测器从 `requireSession(async (context) => {` 一直数到 `})`、把**整个 handler 体**
算进它头上的结果。真正的缺陷是另外两件事：handler 确实有 79 行（已拆），以及该文件的**函数体缩进从 4 空格
漂移到了 2 空格**（封装是后加的、函数体从未重新缩进 —— 已随重写修正）。

**教训**：`最长函数` 这类度量对「包装器 + 内联箭头函数」的结构会误判，报之前要打开文件看一眼。

### 为什么**没有**做 `renderer.ts` 的「字段级解耦」（已评估，别再重复尝试）

原始体检把它列为 P3 的剩余项：「64 个字段收成 `Camera` / `TierCache` 这类状态对象」。**评估后判定不值得做**，理由是三组实测数据：

**1. 字段实际是 47 个，不是 64**（早前那个数字是我的度量把局部常量与类型别名算进去了）。

**2. 类并不「缠」——每方法触碰的字段数中位数是 3：**

| 指标 | 值 |
|---|---|
| 触碰 ≤3 个字段的方法 | **41 / 68** |
| 触碰 ≥8 个字段的方法 | **10 / 68** |
| 每方法字段数的中位数 | **3** |

**3. 最高频的字段全是「当前视图模式标志」**：`worldMode` 被 **23/68** 个方法读、`zoom` 20、`viewProvince` 14、`center` 13、`provinceMode` 12。这类字段在一个渲染器里**本来就该被到处读** —— 「我正在渲染哪张图、在哪个视口」是每个渲染决策的前提。

而触碰字段最多的 10 个方法，每一个都有正当理由：
- `layerInput`（16）—— 它的**职责就是**把字段摊成 `LayerInput`；
- `buildIndexTables`（13）—— 13 次写入全是建表，天然内聚；
- `setWorldMode` / `setProvinceMode` / `drillToProvince` / `backToNation`（11–15）—— 共享同一簇视图状态，是**真正的「视图导航」**；
- `render`（14）—— 渲染入口。

**结论**：把这些字段包进 `Camera` / `ViewState` 对象**不会降低耦合** —— 读它的还是那 60+ 处，只是路径从 `this.worldMode` 变成 `this.view.worldMode`。收益是「字段列表更清楚地分了类」，代价是在行为最密集的文件里做 60+ 处机械改写，而验证只能靠 149 项运行时验收。**那是折腾，不是改进。**
「上帝类」的真正症状（超长函数、散落的重复、反射式访问）已经在前十一轮里消掉了：最长函数 222 → 52、中位数 9 行、7 个模块迁出、探针改为编译期可校验。

**什么时候才值得回头做**：等 `renderer.ts` 再次出现「一个方法碰 12+ 字段**且**它只服务单一职责」的情形 —— 那时说明是**新的职责**混进来了，该抽的是那个职责，而不是把字段换个地方住。



## 本轮（重构 P0）：验收探针隔离 —— 消除「改名后验收静默失效」

**动机**：探针（`?probe=1`）必须读应用内部非公开状态。旧实现在 `src/probe.ts` 里就地写匿名类型再 `as unknown as` 强转，**40 处**、成员一律可选、调用一律 `?.()`。后果是生产侧改名时 `tsc` 与单测全绿，探针却在运行时静默少读一个字段 —— 你会以为验收过了。

**实测证据**（重构前后各做一次受控改名实验）：

| 改名对象 | 重构前 probe 相关编译错误 | 重构后 |
|---|---|---|
| `MapRenderer.setWorldMode`（公开方法） | 1（受保护） | 1（受保护） |
| `MapRenderer.worldNameToIso`（private 字段） | **0 —— 缺口** | **1**：`'zzWorldNameToIso' does not exist in type 'MapRendererDiagnostics'` |
| `MapQuizMode.errorRollback`（protected 字段） | 0 | **1**：报在 `QuizSessionDiagnostics` 字面量上 |
| `InputMode.bfsQueue`（private 字段） | 0 | **1**：报在 `QuizOrderDiagnostics` 字面量上 |

**做法**：把「探针需要哪些内部状态」提升为生产类自己声明的编译期契约 —— 每个类加一个 `diagnostics()`（方法体在类内部，能看见私有成员），返回 getter/setter 组成的**活值视图**：

- `AppController.diagnostics()` → 装配出的内部对象（`src/appDiagnostics.ts`）
- `MapRenderer.diagnostics()` → 只读（`src/map/rendererDiagnostics.ts`）
- `MapQuizMode.diagnostics()` / `InputMode.orderDiagnostics()` → 可读写，探针要构造场景再还原（`src/modes/quizDiagnostics.ts`）

**同时拆分**：`src/probe.ts`（766 行、`installProbe` 单函数 751 行）→ `src/probe/` 五个模块，最长函数 **78 行**；`as unknown as` **40 → 1**（只剩挂 `window.__probe`，无法避免）。

**验收**：tsc 0；vitest **273/273**；`verify-round2` 38/38、`verify-round3` 37/37、`verify-puzzle` 74/74 —— **149 项运行时断言与重构前逐项一致**。

**三个坑**（下一个人别再踩）：

1. 诊断视图返回的是活值 getter。**不要** `{...view}` 展开 —— 那会把 getter 求值成静态快照。
2. 做「改名实验」验证编译器是否抓得住时，**不要用 `git checkout -- <file>` 还原**：那个文件里同时装着你刚写的新代码，会把改动一起抹掉。改用显式备份副本。
3. **`dist/` 的清理问题：更正结论 —— 这是本机环境的产物，不是项目缺陷。**
   我先前写成「`npm run build` 不会清空 `dist/`」，据此加过一个 `npm run clean`（node `rmSync`）——**已回退**，理由见下。
   实测证据（同一台机器、同一个文件）：
   - `node -e "fs.rmSync('dist/xxx',{force:true})"` → **不报错但文件仍在**（node 的删除被静默拦截）；
   - PowerShell `Remove-Item dist/xxx -Force` → **删掉了**；
   - node 在 `%TEMP%` 下 `rmSync` → **正常删除**。
   即：**工作区内的删除对 Node 进程被拦，对 PowerShell 放行**。Vite 的 `emptyOutDir` 走的是 Node 的 `fs.rm`，
   所以在本机表现为「dist 永不被清空」，`dist/assets` 才会累积到 104 个旧 chunk。
   在 CI（Linux）与正常开发机上，Vite 的 `emptyOutDir` 是生效的 —— **不要**为它加 workaround。
   本机上的实用做法：怀疑验收跑的是旧产物时，用 PowerShell 清：`Remove-Item -Recurse -Force dist`。

**另**：探针的动态 chunk 名字由**入口文件 basename**决定，所以入口保留了顶层 `src/probe.ts` 作为 shim（`export { installProbe } from './probe/index'`），使 chunk 仍叫自描述的 `probe-*.js` 而不是与主包同名的 `index-*.js`。**不要**改用 `build.rollupOptions.output.manualChunks` 命名：实测它会把 echarts 等共享依赖拖进该 chunk，并把 `probe-*.js` 变成 index.html 的**静态**引用（每个用户下载 1.1 MB）。

**重构进度（按紧急度）**：

- ✅ **P0 验收探针隔离**（本轮）：见上。
- ✅ **P1 瘦身 `appController`**：`wireDom` **200 → 11 行**（拆成 9 个按域的分发方法 + `wireSegmented()` / `afterScopeChange()` 两个助手），构造器 **113 → 51 行**（抽出 `createRenderer()` / `buildModeCtx()` / `createModes()`），全文件最长函数 **200 → 51 行**。顺手消掉两处重复：6 个分段按钮的 `querySelectorAll` 样板、4 个 handler 里逐字重复的「分段高亮→chrome→进度行→侧栏」四步收尾（漏一处就会出现「按钮说东亚、地图是世界」）。
- ✅ **P2 模式层去重**：跨文件重复的 12 行代码块 **9 → 0**；`countryName` / 省名标签 / 国名标签上提到 `MapQuizMode`（输入模式还私藏了一份与 `province.ts` 完全等价的 `provinceShortName`，已删）；**粒度持久化 4 份拷贝 → `src/modes/granularityStore.ts`**，三个不同的默认值（输入·点击·拼图 = 省级，自由浏览 = 地级）变成调用点上的显式参数。
- 🔶 **P3 拆分 `map/renderer.ts` 上帝类**（进行中）：1846 → **1752 行**（含新增的包装方法与方法级注释；纯搬移出去的部分约 290 行），**最长函数 222 → 49**（`render`），字段仍是 **64**（字段共享是这块硬骨头的核心）。已完成四刀：
  - **第一刀**：构造期几何索引 → `src/map/geoIndex.ts`。`buildProvinceLines` 纯函数化；`buildLabelAnchors` 与 `buildProvinceLabelAnchors` 本是**逐字重复、只差数据源**，合并为一个纯函数。
  - **第二刀**：`src/map/zoom.ts` + `src/map/follow.ts`。缩放范围 `[0.8, 28]` 原先在 `renderer.ts` 与 `puzzle/view.ts` **各定义一份**（只靠注释维系同步），现收敛为一份；跟随钳制的 5 个纯函数与 `FOLLOW_MARGIN_RATIO` / `ViewportWindow` 一并迁出。渲染器只保留**测量**（`viewportWindow()` / `framingExtent()`），**策略**全在 `follow.ts`。`clampFollowAxis` / `FOLLOW_MARGIN_RATIO` **不再从 `renderer.ts` 导出** —— 引用方已改指 `./follow`（单测）与 `../map/follow`（探针）。
  - **第三刀**：构造器 **223 → 9 行**。地图注册表 → `src/map/mapRegistry.ts`；其余拆成 `createInset()` / `buildIndexTables()`，以及**六段内联 ECharts 事件处理器** → `wireChartEvents()` 分发到 `wireChartClick()` / `wireChartHover()` / `wireChartDblClick()` / `wireChartRoam()`。
  - **第四刀**：`render()` **213 → 49 行**。166 行的 option 字面量拆成 `buildTooltipOption()` / `buildGeoOption()` / `buildSeriesOption()`。
  - **第五刀**：`buildSeriesOption()` **113 行 → 5 个 series 构造器**（`eventSeries` / `provinceLinesSeries` / `provinceLikeLabelSeries` / `cityLabelSeries`），并消掉一处真实重复：`world-labels` 与 `province-labels` 的骨架**完全相同**（同 geoIndex、同 silent、同无 tooltip、同字号与衬底比例），原先各写一份、只差 id / z / 「scale 从哪来」，合并为 `provinceLikeLabelSeries(id, z, data, theme, scaleOf)`。**全文件最长函数 222 → 52 行**（起点是构造器 223 / `render` 213 / `wireDom` 199 三个巨物）。
  - **第六刀（数据层）**：10 个纯构造器 + `labelAnchorOf` + `worldFeatureVisible` 薄封装 → **`src/map/layers.ts`**（304 行 / 14 个导出）。渲染器 **1776 → 1617 行、方法 76 → 68**。桥是 `MapRenderer.layerInput(state)`：把 19 个字段摊成一份显式 `LayerInput`，**每次 render 组装一次**喂给所有构造器，数据层因此不持有对渲染器的任何引用。
    - **刻意的边界**：`buildLineData()`（回写 `lineBoxes`）、`applyLabelMode()` / `scheduleLabelModeUpdate()`（碰 ECharts 与定时器）、`worldFaceInteractive()` / `worldFaceContext()`（事件处理器薄封装）**留在渲染器** —— 它们有副作用或只服务事件层。
    - `WORLD_LABEL_ZOOM`（世界国名标签阈值）随之迁到 `layers.ts`（`LABEL_ZOOM` 留在渲染器）。
    - **诊断契约在迁移中被编译器保护**：`diagnostics()` 里暴露的 `buildLabelData` / `buildProvinceLabelData` / `buildWorldLabelData`（探针 `round3Ui` 的 `labelCounts` 用）在方法被删后立刻编译报错，于是改成**同签名的薄封装**（`(state) => buildLabelData(self.layerInput(state))`）—— 探针契约一字未动。**这就是 P0 那层诊断契约在后续重构里的实际价值。**

**P3 状态：函数级拆分已完成。** 最长函数 222 → **52**，中位数 9 行，超过 52 行的函数一个都没有；类从 1846 行降到 **1617 行**，拆出 6 个协作模块（`geoIndex` / `zoom` / `follow` / `mapRegistry` / `layers` / 诊断契约）。

**P3 剩下的只有「字段级」解耦**：类仍有 64 个字段（相机 center/zoom、五档几何缓存、标签定时器、各查表）。要把它们真正降下来需要更深的改造——把相机收成一个 `Camera` 对象、把五档几何收成一个 `TierCache` 对象。那是重新设计而不是"拆方法"，建议单独评估。

**下一步建议（不是 P3 的延续，而是本轮拆分的兑现）**：给 `src/map/layers.ts` 补单测。它现在是**纯函数 + 显式输入**，可以直接构造一个合成 `LayerInput` 断言「范围外的面是 silent + 透明」「装饰面灰显且静默」「hideLabels / labelMode 的分组开关」「世界档国名可见性按次区域优先于大洲」—— 这些目前只能靠 headless Edge 的运行时探针验证，而它们恰恰是最不该依赖浏览器的那类逻辑。可参考 `src/testFixture.ts` 与 `src/map/worldFaces.test.ts` 的写法。

**✅ 已兑现（`src/map/layers.test.ts`，34 个用例）**：上面这些规则现在都有单测锁定，其中最有价值的一条是把 README 记过的坑变成断言 —— **范围外的面必须仍然登记、但 `silent` + 透明 + `emphasis.disabled`**（只跳过外观会让它们回落到 geo 默认样式，于是「空白处悬停高亮看不见的国家」）。另外锁住了：装饰面/被排除极小国的灰显与静默、`worldBoundaryTone` 不影响边界宽度、国名标签的倍率阈值与 `RenderState` 覆盖、次区域优先于大洲、`colorOf` 返回 `blue` 时**不产生标签**（不泄露当前题目）。

写这批测试时踩到的两点（供后续补测参考）：
- `ctx()` 的入参类型要写成 `Partial<Omit<LayerInput, 'state'>> & { state?: Partial<RenderState> }` —— 否则每次传 `state` 都要把必填的 `colorOf` 一起写上。
- `countries` 的元素类型是 `CountryMeta`（含 `fullName` / `neighbors`），不是只有 `iso/name/center/continent`。
- 中文名的默认 `sort()` 是码点序，断言多元素集合时用 `new Set(...)` 比写死顺序更稳。

**测试总数 273 → 307**（新增 `src/map/layers.test.ts` 34 个）。产物已核验**不含测试代码**（`layers.test` / `makeAppData` / 固件里的地名串在 `dist/assets/*.js` 中均搜不到）。

**拆 option 构造器时的两个坑（第四刀实测踩到）**：

1. **上下文类型会丢。** 这些对象字面量原本嵌在 `const option: echarts.EChartsOption = {...}` 里，靠上下文把 `type: 'custom'` 收窄成字面量类型、把 `renderItem(_params, api)` 的参数推断出来。搬成独立方法后必须**显式标注返回类型**才能恢复：
   ```ts
   private buildSeriesOption(...): echarts.EChartsOption['series'] { ... }
   private buildTooltipOption(...): echarts.EChartsOption['tooltip'] { ... }
   private buildGeoOption(...): echarts.EChartsOption['geo'] { ... }
   ```
   不加就会得到 `Type 'string' is not assignable to type '"lines"'` 与一串 `implicitly has an 'any' type`。
2. **`renderItem` 里的 `labelScale(this.zoom)` 不能提前求值。** ECharts 在缩放/拖动时会**反复调用** custom series 的 `renderItem`，每次都该读当时的 `this.zoom`；构建 option 时取快照会让标签字号在缩放中卡住。要做标签系列工厂的话，`scale` 必须作为**闭包**传进去，不能作为值传。

**一个以前没人记录的坑（本轮踩到并修了）**：`src/map/renderer.ts` 原先是 **CRLF**，而仓库里其它所有文件都是 **LF**（`core.autocrlf=true`，所以 git 里一致、只有工作区不一致）。任何按 `\n` 切分后做**严格字符串比较**的脚本（例如找 `"  }"` 收尾）会死循环。已把 `renderer.ts` 转成 LF（**diff 中性**，转前转后 `git diff --stat` 都是 69/166）。新写的脚本仍建议 `split(/\r?\n/)` 并按检测到的 EOL 拼回。

**验收纪律**：每一步都必须同时跑 `npx tsc --noEmit`、`npm test`（273 用例）、以及 `node scripts/verify-round2.mjs` / `verify-round3.mjs` / `verify-puzzle.mjs`（合计 **149 项运行时断言**，基线 38 / 37 / 74）。三者全绿才算落地。

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

- **入口**：mode id 新增 `puzzle`（按 ADR-0001 分配新 id）；页签顺序 点击/输入/**拼图**/无尽/自由。（⚠ 曾写着「不提交排行榜（服务端白名单仍是 self/click/endless）」——**早已过时**：拼图自本轮起提交拼图排行榜，且**所有范围都可提交**，见 `docs/adr/0009`。）
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
