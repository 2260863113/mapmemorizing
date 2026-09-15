/**
 * 取名口径分段按钮的**生成器**：按注册表（`src/modes/naming.ts`）把三组按钮渲染进它们的容器。
 *
 * ## 为什么不是静态 HTML
 * 「有哪些档、叫什么、只在哪些模式提供」是**口径的一部分**，写在 `index.html` 里就等于同一件事说两遍：
 * 2026-09 之前「国旗」这一段的按模式显隐散在 `chromeSync` 里（`#world-name-flag` 写死一个 id），
 * 加一档要从 HTML 抄一遍 id 到 JS。现在 HTML 只留三个空容器，按钮由这张表生成。
 *
 * ## 为什么可以在这里生成（不会有"按钮闪一下"）
 * 三行在 HTML 里都是 `hidden` 起步，只在 `chromeSync` 判定"当前粒度/范围/未开始"之后才显示 ——
 * 生成发生在 boot，比第一次同步早，用户不可能看到中间态。
 */
import { NAMING_GROUPS } from '../modes/naming';
import { $ } from './dom';

/** 渲染全部口径分段按钮（boot 时调用一次；不改状态、只建 DOM）。 */
export function renderNamingGroups(): void {
  for (const group of NAMING_GROUPS) {
    const el = $(group.toggleId);
    // 按钮 id =「容器 id 去掉 -toggle」+ 取值（`world-name-toggle` + `capital` → `world-name-capital`），
    // 与原先静态 HTML 里的 id **逐字一致**：运行时验收脚本按 id 点击这些按钮，id 是它们的稳定契约。
    const idPrefix = group.toggleId.replace(/-toggle$/, '');
    el.setAttribute('aria-label', group.ariaLabel);
    el.innerHTML = group.choices
      .map(
        (choice) =>
          // 模式限制（如「国旗」只在点击模式）挂在按钮上，由 chromeSync 按当前模式显隐 ——
          // 值统一用 `data-naming-value` 承载，接线端不再认识每个字段各自的 dataset 名。
          `<button id="${idPrefix}-${choice.value}" type="button" data-naming-field="${group.field}" data-naming-value="${choice.value}" role="radio" aria-checked="false">${choice.label}</button>`,
      )
      .join('');
  }
}
