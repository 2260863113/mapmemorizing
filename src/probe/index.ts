/**
 * 运行时验收探针（仅在 `?probe=1` 时挂载到 window.__probe）。
 *
 * 为什么需要：本项目多数需求是**运行时行为**（空白区命中、ECharts silent region、
 * 镜头动画与钳制、红显时长、拼图拖拽磁吸），单测只能覆盖抽出来的纯函数，覆盖不到
 * 「真的点下去有没有反应」。探针用真实渲染的 ECharts 实例与真实指针事件做断言。
 *
 * 生产路径不受影响：main.ts 只在 location.search 含 probe=1 时动态 import 本模块，
 * Vite 会把它切成独立 chunk，普通用户不会加载。
 *
 * 模块划分（`__probe` 的 29 个方法按域拆开，装配在下面）：
 *   internals.ts     —— 与应用之间的类型化入口（零强转）
 *   mapProbe.ts      —— 地图 / 镜头 / 世界面 / 跟随钳制
 *   quizProbe.ts     —— 测验（输入·点击）：错误回滚 / 顺序范围 / 排行榜联动 / 范围快照
 *   puzzleProbe.ts   —— 拼图：两阶段、磁吸、难度、获胜
 *   uiProbe.ts       —— 外壳 UI：主题 / 边界深浅 / 标签显隐 / 粒度能力位
 *
 * 私有状态一律经由生产类自己提供的诊断视图读取（`AppController.diagnostics()` 等），
 * 因此本目录**没有任何 `as unknown as` 强转**：成员改名会让 `tsc` 在生产文件里报错。
 */
import type { AppController } from '../appController';
import { probeInternals } from './internals';
import { mapProbe } from './mapProbe';
import { puzzleProbe } from './puzzleProbe';
import { quizProbe } from './quizProbe';
import { uiProbe } from './uiProbe';

export function installProbe(app: AppController) {
  const diag = probeInternals(app);

  const probe = {
    /** 探针可用性自检：应用是否已经装配到可以接受断言的程度。 */
    ready: () => !!diag.renderer && !!diag.data?.countries?.length,

    ...mapProbe(diag),
    ...quizProbe(diag),
    ...puzzleProbe(diag),
    ...uiProbe(diag),
  };

  (window as unknown as { __probe?: typeof probe }).__probe = probe;
}
