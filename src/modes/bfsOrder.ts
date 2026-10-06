/**
 * 顺序模式（输入模式）的**严格广度优先**出题顺序。
 *
 * 抽成纯函数是为了让「不可能出现空洞」这条性质**可被断言**：
 * 它是用户报的缺陷（旧实现是贪心游走，会留空洞），而写死在 InputMode 私有方法里
 * 就只能靠肉眼观察。
 *
 * ## 为什么需要显式队列
 *
 * BFS 的定义决定了：任何时刻「已访问集合」都必须是**从起点出发的一棵连通子树**。
 * 要做到这一点，必须记住**前沿（frontier）**——即「已经在队列里、但还没出题」的那一批。
 * 只记住「上一个访问的是谁」是不够的：那样只能在邻居里挑，挑完就丢了同一层的其它节点，
 * 于是层次被打乱、身后的节点被留成空洞。
 *
 * 旧实现正是后者：「在邻居里随机取一个」+「取最近的未测单位」。
 * 随机取邻居会先访问 d+1 层再回头补 d 层；最近优先会让游走朝一个方向跑远。
 *
 * ## 空洞为什么不可能出现
 *
 * 每次出题都会把该节点的**所有未测邻居**压入队尾。因此若某节点 u 未测且不在队列里，
 * 说明没有任何已访问邻居把 u 压进来 —— 即 u 与起点不连通，它属于另一个连通分量。
 * 分量内的空洞因此不存在；分量之间的跳跃是图本身的性质（BFS 森林），不是顺序错误。
 *
 * ## 邻接优先（2026-09 需求 9）
 *
 * 用户口径：顺序模式**除了要求广度优先，还要优先选队列中与上一个输入地区相邻的那个**。
 * 直观理由是「记地名」这件事本身是沿着边界走的——刚答完广东，下一题若是邻省的广西/湖南，
 * 记忆链条就连得上；若跳到同层但毫不相干的省份，用户会觉得题序乱跳。
 *
 * 实现上**仍然从队列里取**（`queue.splice(idx, 1)`，未选中的元素留在原位），
 * 这是「不出现空洞」那条性质的保证：队列就是前沿，从里面任取一个都仍然合法。
 * 反过来做（像旧实现那样在邻居里随机取、不维护前沿）才会出现空洞。
 */

export interface BfsStep {
  /** 下一题；池内已无可出题时为 null。 */
  next: string | null;
  /** 更新后的前沿队列（调用方需保存，跨题复用）。 */
  queue: string[];
}

export interface BfsInput {
  /** 当前池内的全部 id（当前范围外的单位**不能**出现在这里）。 */
  ids: string[];
  /** id → 邻居 id（可含池外 id，会被自动忽略）。 */
  neighborsOf: (id: string) => string[];
  /** 已作答（对或错）判定。 */
  isDone: (id: string) => boolean;
  /** 当前前沿队列（首题或换域时传空数组）。 */
  queue: string[];
  /** 播种参考点：队列耗尽时取离它最近的未作答单位开新分量。 */
  seedRef: [number, number];
  centerOf: (id: string) => [number, number];
  /**
   * 上一个**已作答**单位（对错都算）。队列里存在与它相邻的节点时优先选那个（按队列顺序取第一个命中的）；
   * 没有命中就取队首。缺省（undefined/null）= 不启用邻接优先，行为与旧版逐字一致。
   */
  lastId?: string | null;
}

function dist2(a: [number, number], b: [number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

/**
 * 队列中**第一个与 lastId 相邻**的元素下标；没有则 -1（调用方回退队首）。
 *
 * 只认「队列里已有」的节点，不去看队列外的邻居：邻接优先是**在已发现的前沿里挑**，
 * 若改成「lastId 的任一未作答邻居优先」，就退化成旧的贪心游走 —— 会把还没被 BFS 发现的
 * 远处节点直接抓进来，层次错乱、空洞重现。
 */
function adjacentIndex(queue: readonly string[], lastId: string | null | undefined, neighborsOf: (id: string) => string[]): number {
  if (!lastId) return -1;
  const adjacent = new Set(neighborsOf(lastId));
  return queue.findIndex((id) => adjacent.has(id));
}

/** 取 BFS 的下一题，并返回更新后的前沿队列。 */
export function bfsStep(input: BfsInput): BfsStep {
  const { ids, neighborsOf, isDone, seedRef, centerOf, lastId } = input;
  const inPool = new Set(ids);
  const remaining = new Set(ids.filter((id) => !isDone(id)));
  if (!remaining.size) return { next: null, queue: [] };

  // 丢掉已作答的（含因换范围而被切出池子的）
  const queue = input.queue.filter((id) => remaining.has(id));

  if (!queue.length) {
    // 分量耗尽（或首题/换域）：从离参考点最近的未作答单位重新播种
    let seed: string | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const id of remaining) {
      const d = dist2(centerOf(id), seedRef);
      if (d < bestD) {
        bestD = d;
        seed = id;
      }
    }
    if (!seed) return { next: null, queue: [] };
    queue.push(seed);
  }

  // 邻接优先：命中则从队列**中间**摘出（其余元素保持原顺序），否则取队首。
  // 注意这一步不做任何"发现新节点"的事 —— 摘出来的那个节点本来就在前沿里。
  const idx = adjacentIndex(queue, lastId, neighborsOf);
  const next = idx >= 0 ? (queue.splice(idx, 1)[0] as string) : (queue.shift() as string);

  const queued = new Set(queue);
  // 关键：把**所有**未作答邻居压入队尾（且只在本池内扩张）
  for (const nb of neighborsOf(next)) {
    if (!inPool.has(nb) || !remaining.has(nb) || queued.has(nb)) continue;
    queue.push(nb);
    queued.add(nb);
  }
  return { next, queue };
}
