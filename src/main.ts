import './styles.css';
import { loadData } from './data';
import { AppController } from './appController';
import { toast } from './ui/dom';
import { t } from './i18n';

async function boot() {
  const data = await loadData();
  const app = new AppController(data);
  app.start();
  // 运行时验收挂钩：仅当 URL 带 ?probe=1 时加载（独立 chunk，普通用户不会拉取）。
  // 用法见 README「运行时验收探针」与 scripts/verify-round2.mjs。
  if (new URLSearchParams(location.search).get('probe') === '1') {
    try {
      // 目录导入（而非 './probe/index'）：Vite 据此把 chunk 命名为自描述的 `probe-*.js`，
      // 而不是与主包同名的 `index-*.js`。
      const { installProbe } = await import('./probe');
      installProbe(app);
    } catch (e) {
      // 探针失败绝不能影响应用本身
      console.warn('probe hook failed:', e);
    }
  }
}

boot().catch((e) => {
  console.error(e);
  toast(t('main.bootFail', { message: e instanceof Error ? e.message : String(e) }));
});
