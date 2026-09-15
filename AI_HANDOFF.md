# 给下一个 AI 的交接文档

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
