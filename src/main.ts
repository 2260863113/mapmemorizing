import './styles.css';
import { loadData, loadRawGeoJson } from './data';
import { AppController } from './appController';
import { toast } from './ui/dom';
import { t } from './i18n';

async function boot() {
  const data = await loadData();
  const app = new AppController(data);
  app.start();
  // 无压缩 raw 档后台异步加载：首屏用 fine 渲染，加载完成后放大到 ≥10 时自动切换最精细档。
  // 失败不影响使用（静默回退到 fine 档）。
  void loadRawGeoJson()
    .then((raw) => app.setRawGeoJson(raw))
    .catch((e) => console.warn('raw 档加载失败，回退到 fine 档', e));
}

boot().catch((e) => {
  console.error(e);
  toast(t('main.bootFail', { message: e instanceof Error ? e.message : String(e) }));
});
