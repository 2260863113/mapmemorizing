import { $ } from './dom';
import type { BoundaryTone, Settings } from '../types';
import { saveSettings } from '../store';
import { loadTinyCountries } from '../tinyCountries';
import { t } from '../i18n';

/** 导航栏设置面板：个性化设置 + 答题范围。 */
export function openSettings(current: Settings, onSave: (s: Settings) => void) {
  const panel = $('settings-panel');
  const darkMode = $('set-dark-mode') as HTMLInputElement;
  const cityBoundaryTone = $('set-city-boundary-tone') as HTMLSelectElement;
  const provinceBoundaryTone = $('set-province-boundary-tone') as HTMLSelectElement;
  const ignoreTiny = $('set-ignore-tiny') as HTMLInputElement;
  darkMode.checked = current.darkMode;
  cityBoundaryTone.value = current.cityBoundaryTone;
  provinceBoundaryTone.value = current.provinceBoundaryTone;
  ignoreTiny.checked = current.ignoreTinyCountries;
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
      darkMode: darkMode.checked,
      ignoreTinyCountries: ignoreTiny.checked,
    };
    saveSettings(s);
    onSave(s);
    close();
  };
}

function boundaryToneOf(value: string, fallback: BoundaryTone): BoundaryTone {
  return value === 'light' || value === 'mid' || value === 'dark' ? value : fallback;
}
