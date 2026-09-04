import type { Mode, RoundResult } from '../types';
import type { ModeController, ModeProgress } from './types';
import type { ModeSettingsPanel } from '../modeSettings';

/**
 * 模式基类：为 ModeController 的全部能力提供无副作用默认实现。
 * 非地图/非计时模式（留言板、管理员）只需覆写真正有意义的方法，
 * 不再被迫写几十个 no-op 桩。地图测验模式（MapQuizMode）也继承它。
 */
export abstract class BaseMode implements ModeController {
  abstract readonly id: Mode;
  abstract readonly title: string;

  abstract enter(): void;
  abstract exit(): void;
  abstract refresh(): void;
  abstract hasProgress(): boolean;

  onSubmit(_v: string): void {}
  onInput(_v: string): void {}
  onUnitClick(_adcode: string): boolean | void { return false; }
  onUnitDblClick(_adcode: string): void {}
  onUnitHover(_adcode: string): void {}
  onUnitHoverEnd(): void {}
  onSkip(): void {}
  onEnd(): void {}
  onViewChange(): void {}
  pause(): void {}
  resume(): void {}
  isPaused(): boolean { return false; }
  getProgress(): ModeProgress | null { return null; }
  getScopeProvince(): string | null { return null; }
  collectResult(): RoundResult | null { return null; }
  isStarted(): boolean { return false; }
  getModeSettings(): ModeSettingsPanel | null { return null; }
}