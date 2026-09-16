# 流量看板的桶标签与分桶用显式站点时区，不用 SQLite 的 `localtime`

管理端「流量看板」（`GET /api/admin/logs?view=stats&range=day|week|month`）需要把访问日志按**小时或天**分桶，并让 x 轴刻度是等距的日历标签。分桶在 SQL 里做（`strftime`），标签序列由 JS 生成（`statsWindow()` 给出窗口边界，SQL 只返回有记录的桶，缺桶补 0）。

最初的实现让两侧**各自依赖"环境时区"**：SQL 用 `strftime(..., 'unixepoch', 'localtime')`，JS 用 `new Date(now).getHours()` 这类宿主时区字段。这在本项目里有三个具体后果，且都不是理论风险：

1. **D1 里没有 tzdata**：`'localtime'` 一律按 **UTC** 解析。实测在本地 D1 上 `'localtime'` 与 `'utc'` 的分桶**逐桶相同（32/32）**，与宿主机是 UTC+8 无关。
2. **Worker 的 `Date` 在本地 dev 下跟宿主时区**：`wrangler pages dev` 里 `new Date().getHours()` 给的是 +08（本机），而线上 Workers 给的是 UTC —— 同一份代码在两种环境下的标签不同。
3. 于是标签与计数落在**不同的时区**上，差整整 8 个小时桶：图上写着 `14:00`，那根柱子的计数却来自 UTC 14:00（= 北京时间 22:00）。**折线整条错位，但图上照样"有数据"**，纯函数单测两半各自都对，所以单测抓不到这一处接缝。

换用浏览器/客户端时区也不成立：窗口边界（"今天 0 点"）必须由服务端确定，而 D1 无法按任意时区做日历分桶（无 tzdata，只能加固定偏移）。

**决定**：桶标签与 SQL 分桶统一使用**一个显式的站点时区偏移**——`SITE_TZ_OFFSET_MINUTES = 480`（北京时间 UTC+8，站点是面向中文用户的 mapmemory.cn，看板只有站长看）：

- JS 侧：`statsWindow()` 把瞬时加上偏移，再用 `getUTC*` 渲染成标签（与宿主时区无关）；
- SQL 侧：`strftime('%Y-%m-%d %H:00', created_at / 1000 + ?2, 'unixepoch')`，`?2` 绑定同一个常数的秒表达 `SITE_TZ_OFFSET_SECONDS`；
- 前端只消费服务端给的标签字符串（`trafficSeries.ts` 里的解析/格式化只做"日历算术"，不改写标签含义）。

**Status**: accepted

**Consequences**:

- 改时区只需改 `SITE_TZ_OFFSET_MINUTES` 一个常数，两侧同时生效；`statsWindow.test.ts` 里的用例一律用"北京时间的某个时刻 → 绝对瞬时"的辅助函数构造，因此在 UTC（CI）与 +08（本机）下断言完全相同。
- 单测里特意留了**跨日/跨小时边界**用例（UTC 15:59 仍是 16 日、UTC 16:01 已是 17 日）：实现若退回用宿主时区字段，在 +08 机器上会整体偏 8 小时，这两条立刻红 —— 这正是 `'localtime'` 那版真出过的错。
- 看板显示的是**北京时间**，与访问明细列表（`formatDateTime` 走浏览器本地时区）在极端情况下可能差一格；站长在 +08 使用，两者一致。若将来要做多时区站点，需要把偏移变成请求参数（`?tz=`），那是一次契约变更而不是改常数。
- 这类"两侧各自依赖环境"的接缝，纯函数单测覆盖不到，因此本仓库外留了一个集成核验脚本（`地图记忆-seed/local-backend-check.mjs`）：起真 `wrangler pages dev` + 独立 `--persist-to` 的本地 D1，灌入时间戳完全已知的日志，把接口返回的桶与独立算出的期望值**逐桶**比对。
