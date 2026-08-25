import './styles.css';
import { loadData, buildIndex } from './data';
import { Matcher } from './matcher';
import { MapRenderer } from './map/renderer';
import { MemoryStore, loadSettings } from './store';
import { SearchBox } from './ui/searchBox';
import { StatsPanel } from './ui/statsPanel';
import { openSettings } from './ui/settingsPanel';
import { $, toast, setHint, showTimer, showSummary, hideSummary } from './ui/dom';
import { FreeMode } from './modes/free';
import { SelfTestMode } from './modes/selfTest';
import { ChallengeMode } from './modes/challenge';
import { MemoryMode } from './modes/memory';
import type { Mode, Settings, Unit } from './types';
import type { ModeCtx, ModeController } from './modes/types';

async function boot() {
  const data = await loadData();
  const idx = buildIndex(data);
  const store = new MemoryStore();
  const settings: Settings = loadSettings();
  const matcher = new Matcher(data);
  const search = new SearchBox('search-input');
  search.setRequireEnter(settings.requireEnter);
  const stats = new StatsPanel('stats', data, store);

  let current: ModeController | null = null;
  const renderer = new MapRenderer($('map'), data, {
    onUnitClick: (adcode) => current?.onUnitClick(adcode),
    onUnitDblClick: (adcode) => current?.onUnitDblClick(adcode),
  });
  renderer.onViewChange = () => current?.refresh();

  const ctx: ModeCtx = {
    data,
    renderer,
    matcher,
    store,
    search,
    stats,
    settings,
    byAdcode: idx.byAdcode,
    toast,
    setHint,
    showTimer,
    showSummary,
    hideSummary,
    randomUnit: (pool: Unit[]) => pool[Math.floor(Math.random() * pool.length)],
  };

  const modes: Record<Mode, ModeController> = {
    free: new FreeMode(ctx),
    self: new SelfTestMode(ctx),
    challenge: new ChallengeMode(ctx),
    memory: new MemoryMode(ctx),
  };

  function switchMode(mode: Mode) {
    if (current === modes[mode]) return;
    if (current && current.hasProgress() && !window.confirm('当前模式进度将丢失，确定切换吗？')) return;
    hideSummary();
    current?.exit();
    current = modes[mode];
    document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    $('search-row').classList.toggle('hidden', mode === 'memory');
    renderer.backToNation();
    const sel = $('province-select') as HTMLSelectElement;
    sel.value = '';
    current.enter();
  }

  // 模式切换
  document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode as Mode));
  });

  // 省份下钻
  const sel = $('province-select') as HTMLSelectElement;
  for (const p of data.provinces) {
    const opt = document.createElement('option');
    opt.value = p.adcode;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    renderer.drillToProvince(sel.value);
  });
  ($('btn-back') as HTMLButtonElement).addEventListener('click', () => {
    renderer.backToNation();
    sel.value = '';
  });

  // 设置
  ($('btn-settings') as HTMLButtonElement).addEventListener('click', () => {
    openSettings(settings, (s) => {
      Object.assign(settings, s);
      search.setRequireEnter(settings.requireEnter);
    });
  });

  // 重置自由模式进度
  ($('btn-reset') as HTMLButtonElement).addEventListener('click', () => {
    if (!window.confirm('确定清空自由模式的全部记忆进度吗？')) return;
    store.reset();
    toast('已重置记忆进度');
  });

  // 搜索框接线（无下拉联想）
  search.onSubmit((v) => current?.onSubmit(v));
  search.onInput((v) => current?.onInput?.(v));

  switchMode('free');
}

boot().catch((e) => {
  console.error(e);
  toast(`启动失败：${e instanceof Error ? e.message : String(e)}`);
});
