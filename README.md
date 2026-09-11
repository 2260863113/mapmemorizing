# 🗺️ 中国行政区记忆

纯前端小项目：帮助记忆中国行政区（精确到地级市）。输入“黔南”这种简称即可让地图上对应区域变色，支持省略“自治州”“土家族”等限定词与错别字容错。

## 一键启动

双击 **`一键启动.bat`**（首次运行会自动安装依赖并打开浏览器），或手动执行：

```bash
npm install
npm run dev
```

然后访问 http://localhost:5173

> 需要 Node.js ≥ 18（推荐 LTS）：https://nodejs.org

## 五种模式

| 模式 | 玩法 |
|---|---|
| **输入模式** | 键盘输入地名作答。答对变绿、答错变红并计入熟练度；原自测模式的相邻扩张和可选倒计时保持不变 |
| **挑战模式** | 键盘输入地名作答，随机出题并倒计时；答对立即进入下一题，答错或超时显示答案后继续。 |
| **点击模式** | 顶部显示随机地名，点击地图对应区域作答；答对变绿，答错时正确答案变红；按当前全国或省份范围出题，不使用自动跟随 |
| **自由模式** | 显示全部地级市名称，可自由缩放、平移和双击区域下钻，不参与答题和计分 |
| **熟练度分析** | 按输入、挑战和点击模式累计的分数给地图分层着色；悬停城市可查看正确/错误次数，右侧显示各省掌握情况 |

## 通用操作

- **答题统计**：正确次数使分数 +1，错误次数使分数 -1；跳过不计入统计。
- **熟练度色阶**：正分 1-2/3-4/≥5 分别为浅/中/深绿色；负分 -1~-2/-3~-4/≤-5 分别为浅/中/深红色；0 分保持地图原色。
- **地名标签**：缩放倍率大于 4 时显示地级标签，较小时隐藏以防止扎堆。
- **省界**：加粗线条显示省级边界（同一地图视图内渲染，无独立图层）。
- **缩放**：滚轮自由缩放、拖拽平移（两个图层同步）。
- **省份下钻**：在地图上双击任意区域进入该省；空白区域点击返回全国。
- **输入匹配（无下拉联想）**：输入“黔南布依族苗族自治州”“黔南州”“黔南”均可命中“黔南”；错别字（编辑距离≤2）可容错；输入省名（如“贵州省”）直接下钻该省。
- 记忆单位：333 个地级行政区 + 北京/上海/天津/重庆/香港/澳门/台湾 7 个整体单位（共 340 个）；省直辖县级区域作为灰色填充面补齐地图空白，不参与答题统计。

## 数据说明

- 地级/省级边界数据来自[阿里云 DataV.GeoAtlas](https://geodataviewer.com/datasets/boundaries/chinese-admin-boundaries/)（免费、无 Key），已打包进 `public/data/`，运行时不依赖网络
- 重新生成数据（需网络，可加 `--no-simplify` 关闭几何简化）：

```bash
npm run build:data
```

- 世界边界数据来自 [Natural Earth 10m admin_0 countries 中国视角变体 `_chn`](https://www.naturalearthdata.com/)（公有领域），经 `scripts/fetch-world-data-v2.mjs` 简化为 `public/data/world_v2.topojson`
  - 中位线段 0.163°（1000px 世界图下约 0.45px），旧档为 0.733°（约 2.04px），精细度提升 4.5 倍
  - **必须用 `_chn` 变体**：标准版把**藏南**划给印度（实测 8 个藏南城镇旧档归中国 8/8、NE50 标准版 4/8、`_chn` 8/8）。该变体由 Natural Earth 官方完成边界处理，本管线无需任何多边形布尔运算
  - 答题国 iso 集合与 `countries.json` 逐字相同（195 个，零重复）；装饰面数量随源变化（现 49 个），故**不作为契约**——契约是「装饰面不得持有答题池内的 iso」
  - 中国在世界图上仍是**一个合并面**（含台湾/香港/澳门，`_chn` 变体已预合并台湾），并由旧档回补 5 个最南端南海岛礁多边形（曾母暗沙约 3.4°N）
  - 领土口径有语义断言守护：藏南 8 个真实城镇必须全落在中国面内、中国面最南纬度必须低于 5°N
  - 重新生成：`node scripts/fetch-world-data-v2.mjs`
  - 旧档 `world.geojson` 与旧管线 `scripts/fetch-world-data.mjs` **保留在库中但不再加载**（回滚路径：把 `src/data.ts` 的 `world_v2.topojson` 换回 `world.geojson`）
- 邻接关系（输入模式 BFS 扩张用）由构建脚本用 turf 自动计算，存在 `units.json` 的 `neighbors` 字段；国家邻接在 `countries.json` 的 `neighbors`
- 世界地图对比图（人工验收用）：`node scripts/shot-world-compare.mjs` → `shot-world/`（5 组，同投影对比新旧两个几何源，每组上=旧档、下=新档）

## 项目结构

```
scripts/fetch-cn-atlas.mjs # 数据管线：下载 cn-atlas TopoJSON → 拓扑保持简化（双档）→ 输出
scripts/fetch-world-data-v2.mjs # 世界数据管线：Natural Earth 10m _chn → 合并中国面 → dp12 TopoJSON
scripts/shot-world-compare.mjs  # 世界换源前后对比出图（同投影对比新旧两源，人工验收用）
scripts/check-data.mjs     # 数据校验：逐面几何有效性 + 单位覆盖
public/data/             # 构建产物：china_units.json / china_units_coarse.json（TopoJSON 双档）+ units.json + world_v2.topojson
src/
  matcher.ts             # 地名规范化 + 模糊匹配 + 消歧
  map/renderer.ts        # ECharts 渲染：着色/标签/下钻/高亮动画
  store.ts               # 答题统计、旧记忆兼容与设置（localStorage）
  modes/                 # 输入 / 挑战 / 点击 / 自由 / 熟练度分析
  ui/                    # 搜索框、倒计时、统计面板、设置面板
  main.ts                # 装配入口
```

## 其他命令

```bash
npm run build    # 类型检查 + 生产构建（dist/）
npm run preview  # 预览生产构建
```
