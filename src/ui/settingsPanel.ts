import { $ } from './dom';
import type { BoundaryTone, Settings } from '../types';
import { saveSettings } from '../store';

/** 导航栏设置面板：仅保留个性化设置（黑夜模式、地级市/省级边界）。 */
export function openSettings(current: Settings, onSave: (s: Settings) => void) {
  const panel = $('settings-panel');
  const darkMode = $('set-dark-mode') as HTMLInputElement;
  const cityBoundaryTone = $('set-city-boundary-tone') as HTMLSelectElement;
  const provinceBoundaryTone = $('set-province-boundary-tone') as HTMLSelectElement;
  darkMode.checked = current.darkMode;
  cityBoundaryTone.value = current.cityBoundaryTone;
  provinceBoundaryTone.value = current.provinceBoundaryTone;
  panel.classList.remove('hidden');

  const close = () => panel.classList.add('hidden');
  ($('set-cancel') as HTMLButtonElement).onclick = close;
  ($('set-save') as HTMLButtonElement).onclick = () => {
    const s: Settings = {
      cityBoundaryTone: boundaryToneOf(cityBoundaryTone.value, current.cityBoundaryTone),
      provinceBoundaryTone: boundaryToneOf(provinceBoundaryTone.value, current.provinceBoundaryTone),
      darkMode: darkMode.checked,
    };
    saveSettings(s);
    onSave(s);
    close();
  };
}

function boundaryToneOf(value: string, fallback: BoundaryTone): BoundaryTone {
  return value === 'light' || value === 'mid' || value === 'dark' ? value : fallback;
}
