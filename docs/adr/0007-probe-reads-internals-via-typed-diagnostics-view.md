# 验收探针通过生产类自带的诊断视图访问内部状态，不使用反射

`?probe=1` 的运行时验收探针（`installProbe`）必须读到应用内部**非公开**的状态：相机的 center/zoom、当前地图档位与视图模式、世界面命中判定表、最近一次渲染状态、测验会话的正确/错误集合与错误回滚计数、拼图盘面的组结构。TypeScript 的 `private` / `protected` 只在编译期生效，运行时照常可达，所以旧实现的做法是探针侧就地写一个匿名类型再 `as unknown as` 强转。

这个做法有三个具体后果，都不是理论风险：

1. **断言不受编译器保护。** 强转目标是一个各家自写的匿名形状，成员一律可选、调用一律 `?.()`。生产侧一改名，`tsc` 与 273 个单测都不报错，探针却在运行时静默少读一个字段或干脆不执行那一步 —— 读者会以为"验收过了"。已实测：把 `MapRenderer.worldNameToIso` 改名，探针相关编译错误为 **0**。
2. **契约散落。** 探针里 760 行散着 **40 处**互不相关的强转，任何渲染器/模式的私有重构都要人工 audit 整个探针（compiler 帮不上忙）。
3. **跨文件重复定义。** `verify-round3.mjs` 的 `labelCounts` 断言依赖"渲染器私有构造器必须带 receiver 调用"这类只有注释才知道的隐式契约（`fn.call(renderer, state)`），改动时没人会想起来。

因此把"探针需要哪些内部状态"提升为**生产类自己声明的一份编译期可校验契约**：每个被探针读取的类提供一个 `diagnostics()` 方法，方法体在类内部（因此能看见私有成员），返回一个 getter/setter 组成的**活值视图**。

- `AppController.diagnostics()` → 装配出的各内部对象（渲染器、各模式、面板、设置）
- `MapRenderer.diagnostics()` → 只读：相机 / 视图模式 / 世界面命中表 / 渲染状态
- `MapQuizMode.diagnostics()` → 可读写：会话状态（探针要构造场景再还原）
- `InputMode.orderDiagnostics()` → 可读写：顺序出题的 BFS 前沿队列

形状分别声明在 `src/appDiagnostics.ts`、`src/map/rendererDiagnostics.ts`、`src/modes/quizDiagnostics.ts`，与实现同目录。

**Status**: accepted

**Consequences**:

- 探针目录 `src/probe/` **不再有任何强转**（唯一的 `as unknown as` 是把 `probe` 挂到 `window` 上，无法避免）。成员改名 / 删除 / 改签名会让 `tsc` 在**生产文件**里直接报错，而不是让探针在验收时静默失效。实测：改名 `worldNameToIso` / `errorRollback` / `bfsQueue`，三处都精确报在对应的诊断对象字面量上。
- 视图返回的是**活值**（getter/setter 直接读写当前字段），探针取一次即可长期持有；**不要**用 `{...view}` 展开，那会把 getter 求值成静态快照。
- 生产路径不调用这些方法，`?probe=1` 之外零运行时成本；代价是类上多了一个公开方法（每个约 20–50 行）。这是**刻意的**：把隐式耦合变成显式契约，是这一层存在的全部意义。
- `ModeController` **不**新增 `diagnostics`——那是生产契约，不该被测试关注点污染。需要它的地方用 `AppDiagnostics.current` 上的交叉类型 `ProbeableMode` 表达（只有测验模式提供）。
- `PuzzleMode` 的 8 个 `debug*` 方法**暂时保留**：把它们移出生产类需要暴露 `state` / `view` / `baseScale()` / `family()` 等更多内部，反而扩大耦合面。待模式层去重时一并评估。
