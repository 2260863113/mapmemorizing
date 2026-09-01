import { $ } from './dom';
import type { ModeSettingsPanel } from '../modeSettings';
import { t } from '../i18n';

/** 每模式设置小浮层面板：显示该模式的开关选项，点击外部或关闭按钮收起。 */
export function openModeSettings(panel: ModeSettingsPanel) {
  const el = $('mode-settings-panel');
  const toggles = panel.toggles
    .map(
      (item) =>
        `<label class="row mode-setting-toggle${item.fixed ? ' fixed' : ''}"><input type="checkbox" data-key="${item.key}" ${item.value ? 'checked' : ''} ${item.fixed ? 'disabled' : ''} /> ${item.label}</label>`,
    )
    .join('');
  el.innerHTML = `<div class="card mode-settings-card"><h3>${panel.title}</h3>${toggles}<div class="card-actions"><button id="mode-settings-close" class="ghost">${t('common.close')}</button></div></div>`;
  el.classList.remove('hidden');

  el.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-key]').forEach((input) => {
    input.addEventListener('change', () => {
      panel.onChange(input.dataset.key ?? '', input.checked);
    });
  });

  const close = () => el.classList.add('hidden');
  ($('mode-settings-close') as HTMLButtonElement).onclick = close;
  el.addEventListener('click', (event) => {
    if (event.target === el) close();
  });
}
