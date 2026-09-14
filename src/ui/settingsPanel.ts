import { $ } from './dom';
import type { BoundaryTone, Settings } from '../types';
import { saveSettings } from '../store';
import { loadTinyCountries } from '../tinyCountries';
import { t } from '../i18n';

/**
 * 导航栏全局设置面板：个性化（地级/省级/世界边界深浅）+ 答题范围 + 地图标签。
 *
 * 黑夜模式不在这里——它已改为顶栏「设置」左侧的黑夜/白天模式按钮（见 AppController）。
 * 保存时保留 current 的主题值，避免把面板未管理的设置项清掉。
 */
export function openSettings(current: Settings, onSave: (s: Settings) => void) {
  const panel = $('settings-panel');
  const cityBoundaryTone = $('set-city-boundary-tone') as HTMLSelectElement;
  const provinceBoundaryTone = $('set-province-boundary-tone') as HTMLSelectElement;
  const worldBoundaryTone = $('set-world-boundary-tone') as HTMLSelectElement;
  const ignoreTiny = $('set-ignore-tiny') as HTMLInputElement;
  const showBrowseLabels = $('set-show-browse-labels') as HTMLInputElement;
  cityBoundaryTone.value = current.cityBoundaryTone;
  provinceBoundaryTone.value = current.provinceBoundaryTone;
  worldBoundaryTone.value = current.worldBoundaryTone;
  ignoreTiny.checked = current.ignoreTinyCountries;
  showBrowseLabels.checked = current.showBrowseLabels;
  // 清单在数据加载时已就绪（同步读缓存）；数量写进标签，让用户知道开关影响范围
  const tiny = loadTinyCountries();
  const hint = $('set-ignore-tiny-hint');
  hint.textContent = tiny.length ? t('settings.ignoreTinyHint', { count: tiny.length }) : t('settings.ignoreTinyUnavailable');
  panel.classList.remove('hidden');

  const close = () => panel.classList.add('hidden');
  ($('set-cancel') as HTMLButtonElement).onclick = close;
  ($('set-save') as HTMLButtonElement).onclick = () => {
    const s: Settings = {
      cityBoundaryTone: boundaryToneOf(cityBoundaryTone.value, current.cityBoundaryTone),
      provinceBoundaryTone: boundaryToneOf(provinceBoundaryTone.value, current.provinceBoundaryTone),
      worldBoundaryTone: boundaryToneOf(worldBoundaryTone.value, current.worldBoundaryTone),
      darkMode: current.darkMode,
      ignoreTinyCountries: ignoreTiny.checked,
      showBrowseLabels: showBrowseLabels.checked,
    };
    saveSettings(s);
    onSave(s);
    close();
  };
}

function boundaryToneOf(value: string, fallback: BoundaryTone): BoundaryTone {
  return value === 'light' || value === 'mid' || value === 'dark' ? value : fallback;
}
