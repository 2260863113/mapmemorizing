import { $ } from './dom';
import type { Settings } from '../types';
import { saveSettings } from '../store';

/** 设置面板：自测倒计时 / 挑战每题秒数 */
export function openSettings(current: Settings, onSave: (s: Settings) => void) {
  const panel = $('settings-panel');
  const enable = $('set-self-enable') as HTMLInputElement;
  const secs = $('set-self-secs') as HTMLInputElement;
  const chal = $('set-challenge-secs') as HTMLInputElement;
  enable.checked = current.selfTimerEnabled;
  secs.value = String(current.selfTimerSeconds);
  chal.value = String(current.challengeSeconds);
  panel.classList.remove('hidden');

  const close = () => panel.classList.add('hidden');
  ($('set-cancel') as HTMLButtonElement).onclick = close;
  ($('set-save') as HTMLButtonElement).onclick = () => {
    const s: Settings = {
      selfTimerEnabled: enable.checked,
      selfTimerSeconds: Math.max(5, Number(secs.value) || 60),
      challengeSeconds: Math.max(3, Number(chal.value) || 10),
    };
    saveSettings(s);
    onSave(s);
    close();
  };
}
