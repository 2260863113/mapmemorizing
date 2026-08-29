import { $ } from './dom';
import type { BoundaryTone, Settings } from '../types';
import { saveSettings } from '../store';

/** 设置面板：测试选项 / 个性化 */
export function openSettings(current: Settings, onSave: (s: Settings) => void) {
  const panel = $('settings-panel');
  const enable = $('set-self-enable') as HTMLInputElement;
  const requireEnter = $('set-require-enter') as HTMLInputElement;
  const autoFollow = $('set-auto-follow') as HTMLInputElement;
  const darkMode = $('set-dark-mode') as HTMLInputElement;
  const followZoom = $('set-follow-zoom') as HTMLInputElement;
  const cityBoundaryTone = $('set-city-boundary-tone') as HTMLSelectElement;
  const provinceBoundaryTone = $('set-province-boundary-tone') as HTMLSelectElement;
  const secs = $('set-self-secs') as HTMLInputElement;
  enable.checked = current.selfTimerEnabled;
  requireEnter.checked = current.requireEnter;
  autoFollow.checked = current.autoFollow;
  darkMode.checked = current.darkMode;
  followZoom.value = String(current.followZoom);
  cityBoundaryTone.value = current.cityBoundaryTone;
  provinceBoundaryTone.value = current.provinceBoundaryTone;
  secs.value = String(current.selfTimerSeconds);
  panel.classList.remove('hidden');

  const close = () => panel.classList.add('hidden');
  ($('set-cancel') as HTMLButtonElement).onclick = close;
  ($('set-save') as HTMLButtonElement).onclick = () => {
    const s: Settings = {
      selfTimerEnabled: enable.checked,
      selfTimerSeconds: Math.max(5, Number(secs.value) || 60),
      requireEnter: requireEnter.checked,
      autoFollow: autoFollow.checked,
      followZoom: Math.min(28, Math.max(2, Number(followZoom.value) || current.followZoom)),
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
