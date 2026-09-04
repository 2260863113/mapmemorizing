import './styles.css';
import { loadData } from './data';
import { AppController } from './appController';
import { toast } from './ui/dom';
import { t } from './i18n';

async function boot() {
  const data = await loadData();
  const app = new AppController(data);
  app.start();
}

boot().catch((e) => {
  console.error(e);
  toast(t('main.bootFail', { message: e instanceof Error ? e.message : String(e) }));
});
