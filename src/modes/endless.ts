import type { Mode, RoundResult, Unit } from '../types';
import type { ModeCtx } from './types';
import { BaseMode } from './baseMode';
import { Countdown } from '../ui/countdown';
import { $, endlessFood, endlessItems, endlessStatus, endlessToken, flashTimerPenalty, hideLevelEnd, hideShop, showLevelEnd, showShop } from '../ui/dom';
import { formatElapsedSeconds } from '../ui/format';
import { clamp } from '../math';
import { t } from '../i18n';
import { ENDLESS_FOLLOW_ZOOM, loadEndlessAutoFollow, saveEndlessAutoFollow, type ModeSettingsPanel } from '../modeSettings';
import { fbm, makePermutation } from './endlessNoise';
import { FOODS, ITEM_DEFS, ITEM_KEYS, pickInitialFoods, pickTokenChar, type FoodEntry, type ItemKey, type OwnedItem } from './endlessData';
import {
  COIN_LABEL_ZOOM,
  COIN_NOISE_AMPLIFY,
  COIN_NOISE_SCALE,
  HOURGLASS_USES,
  LEVEL_SECONDS,
  POTION_REVEAL_MS,
  POTION_USES,
  WRONG_INPUT_COIN_LOSS,
  cloverBonus,
  coinValue,
  cumulativeTarget,
  floatUpIncrement,
  foodBonus as foodBonusAmount,
  hourglassSeconds,
  nextPrice,
  rollShopKeys,
  tokenBonus,
  tokenMatchesName,
} from './endlessEconomy';

/**
 * 无尽闯关：
 * 每关限时 45 秒，输入地级市名称收集金币。每关以「时间结束」为结束条件，
 * 结束时累计金币达到累计目标则展示通关卡片，点「继续」进入道具商店；购买道具后再次点「继续」进入下一关。
 * 累计金币跨关保留（购买道具会消耗金币）；每个地级市收集后下一关恢复可再次收集。
 * 初始金币基于柏林噪声生成（约 50-400），相邻地级市平滑过渡。
 * 道具产生的额外金币不超过该地名本身价格。
 */
export class EndlessMode extends BaseMode {
  id: Mode = 'endless';
  title = t('mode.endless.title');
  private coins = new Map<string, number>(); // 当前金币数（0 = 本关已收集，下一关恢复）
  private collectedThisLevel = new Set<string>(); // 本关已收集（用于显示地名）
  private level = 1;
  private target = 0;
  private levelCoins = 0;
  private totalCoins = 0;
  private totalCollects = 0; // 累计收集次数（含跨关重复收集）
  private targetHit = false; // 本关是否已达成目标（仅提示用）
  private started = false;
  private paused = false;
  private switching = false; // 通关卡片/商店展示期（拦截输入/暂停）
  private runStartAt = 0;
  private countdown = new Countdown();
  private perm: Uint8Array = makePermutation(randomSeed());
  private syncingView = false;
  private hidePrices = loadHidePrices(); // 隐藏价格标签
  private hidePriceBg = loadHidePriceBg(); // 隐藏价格标签衬底
  // 道具
  private owned: OwnedItem[] = []; // 当前生效的道具（药水跨关携带，其余仅限下一关）
  private itemPrices = new Map<ItemKey, number>(); // 各道具当前价格
  private tokenChar = ''; // 飞花令牌关键字
  private tokenMatches = 0;
  private revealAllNames = false; // 透视药水：显示全国地名
  private revealTimer: number | null = null;
  private shopKeys: ItemKey[] = []; // 本关商店可供购买的道具（每件 50% 概率出现）
  private boughtThisShop = new Set<ItemKey>(); // 本关商店已购买（每件每关仅能买一次）
  private foodActive = false; // 本关是否使用了美食鉴赏家
  private activeFoods: FoodEntry[] = []; // 当前显示的 5 种食物
  private usedFoods = new Set<string>(); // 本关已使用的食物

  private autoFollow = loadEndlessAutoFollow(); // 自动跟随（倍率固定默认值）

  constructor(private ctx: ModeCtx) {
    super();
    // 透视药水：任意方向键使用
    document.addEventListener('keydown', (event) => {
      if (!this.started || this.paused || this.switching) return;
      if (event.key.startsWith('Arrow')) this.usePotion();
    });
  }

  getModeSettings(): ModeSettingsPanel | null {
    return {
      title: t('mode.endless.title'),
      toggles: [
        { key: 'require-enter', label: t('settings.requireEnter'), value: true, fixed: true }, // 无尽固定按下 Enter 确认
        { key: 'hide-prices', label: t('settings.hidePrices'), value: this.hidePrices },
        { key: 'hide-price-bg', label: t('settings.hidePriceBg'), value: this.hidePriceBg },
        { key: 'auto-follow', label: t('settings.autoFollow'), value: this.autoFollow },
      ],
      onChange: (key, value) => {
        if (key === 'hide-prices') {
          this.setHidePrices(value);
        } else if (key === 'hide-price-bg') {
          this.setHidePriceBg(value);
        } else if (key === 'auto-follow') {
          this.autoFollow = value;
          saveEndlessAutoFollow(value);
        }
      },
    };
  }

  enter() {
    if (this.paused) {
      this.syncScope();
      this.ctx.setHint(''); // 清除其他模式遗留的开始卡片
      this.ctx.search.setPlaceholder(t('self.placeholderFull'));
      this.ctx.search.setRequireEnter(true);
      endlessStatus(this.statusHtml());
      this.refresh();
      this.ctx.showTimer(this.countdown.remaining());
      this.ctx.updateProgress();
      this.ctx.search.clear();
      return;
    }
    this.exit();
    this.resetRun();
    this.ctx.search.setPlaceholder(t('self.placeholderFull'));
    this.ctx.search.setRequireEnter(true);
    this.syncScope();
    this.showStartHint();
    this.refresh();
    this.ctx.updateProgress();
    this.ctx.search.clear();
  }

  exit() {
    this.countdown.stop();
    this.ctx.showTimer(null);
    hideLevelEnd();
    hideShop();
    endlessStatus('');
    endlessItems('');
    endlessToken('');
    endlessFood('');
    this.started = false;
    this.paused = false;
  }

  pause() {
    if (!this.started || this.paused || this.switching) return;
    this.paused = true;
    this.countdown.pause();
    this.ctx.showTimer(this.countdown.remaining());
  }

  resume() {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.countdown.resume();
    endlessStatus(this.statusHtml());
    // 暂停期间透视药水可能已到期：revealAllNames 已复位但地图未重绘，恢复时刷新
    this.refresh();
  }

  isPaused() {
    return this.paused;
  }

  refresh() {
    this.ctx.renderer.render({
      colorOf: () => 'gray',
      labelZoomThreshold: COIN_LABEL_ZOOM,
      coin: {
        coins: (adcode) => this.coins.get(adcode) ?? 0,
        label: (adcode) => this.labelOf(adcode),
      },
    });
  }

  hasProgress() {
    return this.started || this.totalCollects > 0;
  }

  getProgress() {
    return null; // 无尽闯关不使用逐单位进度条
  }

  isStarted() {
    return this.started;
  }

  getScopeProvince() {
    return null; // 全国固定范围，不下钻
  }

  /** 隐藏价格标签开关（无尽设置卡片）。 */
  setHidePrices(hidden: boolean) {
    this.hidePrices = hidden;
    saveHidePrices(hidden);
    if (this.started) this.refresh();
  }

  isHidePrices() {
    return this.hidePrices;
  }

  /** 隐藏价格标签衬底开关：价格变为白色填充 + 黑色描边、无衬底。 */
  setHidePriceBg(hidden: boolean) {
    this.hidePriceBg = hidden;
    saveHidePriceBg(hidden);
    if (this.started) this.refresh();
  }

  isHidePriceBg() {
    return this.hidePriceBg;
  }

  onSubmit(v: string) {
    if (!this.started || this.paused || this.switching || !v.trim()) return;
    const best = this.ctx.matcher.bestUnit(v);
    if (!best) {
      if (this.hasItem('shield')) {
        // 盾牌：输错不扣金币、不扣时间
        this.ctx.toast(t('endless.shieldBlocked'));
        return;
      }
      this.ctx.toast(t('endless.matchFail'));
      this.penalize(5);
      this.totalCoins = Math.max(0, this.totalCoins - WRONG_INPUT_COIN_LOSS);
      endlessStatus(this.statusHtml());
      return;
    }
    const value = this.coins.get(best.adcode) ?? 0;
    if (!Number.isFinite(value) || value <= 0) {
      this.ctx.toast(t('endless.alreadyCollected'));
      return;
    }
    this.collect(best, value);
  }

  onInput(_v: string) {
    /* 无尽闯关必须按 Enter 确认，不做实时输入判定 */
  }

  onUnitClick() {
    return true; // 拦截下钻，固定全国视图
  }

  onUnitDblClick() {
    this.ctx.toast(t('endless.noDrill'));
  }

  onSkip() {
    /* 无跳过 */
  }

  onEnd() {
    this.pause();
  }

  onReset() {
    this.countdown.stop();
    this.ctx.showTimer(null);
    hideLevelEnd();
    hideShop();
    this.resetRun();
    this.enter();
  }

  onViewChange() {
    if (this.syncingView) return;
    if (this.ctx.renderer.currentProvince() !== null) {
      this.syncingView = true;
      this.ctx.renderer.backToNation();
      this.syncingView = false;
    }
  }

  // ---------- 内部 ----------

  private syncScope() {
    if (this.ctx.renderer.currentProvince() !== null) this.ctx.renderer.backToNation();
  }

  private resetRun() {
    this.level = 1;
    this.target = 0;
    this.levelCoins = 0;
    this.totalCoins = 0;
    this.totalCollects = 0;
    this.targetHit = false;
    this.runStartAt = 0;
    this.collectedThisLevel.clear();
    this.coins.clear();
    this.owned = [];
    this.itemPrices.clear();
    this.tokenChar = '';
    this.tokenMatches = 0;
    this.revealAllNames = false;
    this.shopKeys = [];
    this.boughtThisShop.clear();
    this.foodActive = false;
    this.activeFoods = [];
    this.usedFoods.clear();
    if (this.revealTimer !== null) {
      window.clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    this.started = false;
    this.paused = false;
    this.switching = false;
    hideLevelEnd();
    hideShop();
    endlessStatus('');
    endlessItems('');
    endlessToken('');
    endlessFood('');
  }

  private showStartHint() {
    const actions = `<button id="endless-start" class="start-action">${t('common.start')}</button>`;
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">${t('endless.startTitle')}</div><div class="start-subtitle">${t('endless.startScope')}</div>${actions}</div>`);
    window.setTimeout(() => {
      const start = document.getElementById('endless-start') as HTMLButtonElement | null;
      if (start) start.onclick = () => this.start();
    }, 0);
  }

  private start() {
    if (this.started || this.paused || this.switching) return;
    this.syncScope();
    this.ctx.setHint(''); // 点击开始后隐藏开始卡片
    this.perm = makePermutation(randomSeed()); // 每轮重新生成噪声，起始分布不重复
    this.level = 1;
    this.collectedThisLevel.clear();
    this.totalCoins = 0;
    this.levelCoins = 0;
    this.totalCollects = 0;
    this.targetHit = false;
    this.coins = this.generateCoins();
    this.target = cumulativeTarget(1);
    this.runStartAt = Date.now();
    this.started = true;
    this.paused = false;
    this.switching = false;
    endlessStatus(this.statusHtml());
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.refresh();
    this.renderItems();
    this.renderToken();
    this.renderFoods();
    this.countdown.start(LEVEL_SECONDS, (r) => this.showCountdown(r), () => this.onLevelTimeout());
  }

  private showCountdown(remainingMs: number) {
    this.ctx.showTimer(remainingMs, remainingMs < 10_000);
  }

  /** 每关结束条件 = 时间结束；结束时按是否达标决定通关或结束。 */
  private onLevelTimeout() {
    if (!this.started || this.paused || this.switching) return;
    this.countdown.stop();
    this.ctx.showTimer(null);
    if (this.totalCoins >= this.target) {
      this.showLevelEnd();
      return;
    }
    this.gameOver();
  }

  private collect(unit: Unit, value: number) {
    this.coins.set(unit.adcode, 0);
    this.collectedThisLevel.add(unit.adcode);
    let bonus = 0;
    // 幸运草：额外 50-100 金币（不超过地名本身价格）
    if (this.hasItem('clover')) bonus += cloverBonus(rand, value);
    // 飞花令牌：含关键字的地名额外获得金币，逐次递增（不超过地名本身价格）
    if (this.hasItem('token') && this.tokenChar && tokenMatchesName(this.tokenChar, unit.name, unit.shortName)) {
      bonus += tokenBonus(rand, value, this.tokenMatches);
      this.tokenMatches += 1;
    }
    // 美食鉴赏家：命中食物省份额外 50-100 金币（不超过地名本身价格），随后该食物作废并替换
    let foodBonus = 0;
    const food = this.foodForUnit(unit);
    if (food) {
      foodBonus = foodBonusAmount(rand, value);
      bonus += foodBonus;
      this.consumeFood(food);
    }
    this.levelCoins += value + bonus;
    this.totalCoins += value + bonus;
    this.totalCollects += 1;
    // 时间沙漏：每次输入成功倒计时 +3~5 秒（共 5 次，自动激活）
    let timeBonus = 0;
    const hourglass = this.owned.find((o) => o.key === 'hourglass');
    if (hourglass && hourglass.durability > 0) {
      timeBonus = hourglassSeconds(rand);
      this.countdown.add(timeBonus * 1000);
      hourglass.durability -= 1;
      if (hourglass.durability <= 0) this.owned = this.owned.filter((o) => o.durability > 0);
      this.renderItems();
    }
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.refresh();
    this.ctx.renderer.flash(unit.adcode);
    if (this.autoFollow) this.ctx.renderer.focusUnit(unit.adcode, ENDLESS_FOLLOW_ZOOM);
    const extras: string[] = [];
    if (bonus > 0) extras.push(t('endless.bonusCoins', { value: fmt(bonus) }));
    if (timeBonus > 0) extras.push(t('endless.timeBonus', { seconds: timeBonus }));
    const extraTxt = extras.length ? t('endless.extraWrap', { list: extras.join(t('endless.listSeparator')) }) : '';
    if (!this.targetHit && this.totalCoins >= this.target) {
      this.targetHit = true;
      this.ctx.toast(t('endless.targetReached', { value: fmt(this.target) }));
    } else {
      this.ctx.toast(t('endless.collectSuccess', { name: unit.name, value: fmt(value), extra: extraTxt }));
    }
    endlessStatus(this.statusHtml());
  }

  /** 匹配失败惩罚：倒计时扣减指定秒数并让倒计时卡片闪烁变红。 */
  private penalize(seconds: number) {
    this.countdown.penalize(seconds * 1000);
    flashTimerPenalty();
  }

  /** 达标通关：屏幕中心展示通关卡片（美食鉴赏家本关使用时附答案表），点「继续」进入道具商店。 */
  private showLevelEnd() {
    this.switching = true;
    endlessStatus('');
    // 单关道具已用完，药水跨关携带
    this.owned = this.owned.filter((o) => o.key === 'potion');
    const usedFood = this.foodActive; // 记住本关是否使用了美食鉴赏家（先于清理保存）
    this.clearLevelItemFx();
    this.renderItems();
    const foodTable = usedFood
      ? `<div class="food-answer"><div class="food-answer-title">${t('endless.foodAnswerTitle')}</div>${FOODS.map(
          (f) => `<div class="food-answer-row"><span>${f.food}</span><span>${f.province}</span></div>`,
        ).join('')}</div>`
      : '';
    showLevelEnd(
      `<div class="level-end-title">${t('endless.levelEndTitle', { level: this.level })}</div>` +
        `<div class="sum-stats">${t('endless.levelEndTarget', { coins: fmt(this.target) })}</div>` +
        `<div class="sum-stats">${t('endless.levelEndTotal', { coins: fmt(this.totalCoins) })}</div>` +
        `<div class="sum-stats">${t('endless.levelEndLevel', { coins: fmt(this.levelCoins) })}</div>` +
        foodTable,
      () => this.openShop(),
    );
  }

  /** 道具商店：每件道具 50% 概率出现，每关仅可购买一次。 */
  private openShop() {
    this.switching = true;
    this.shopKeys = rollShopKeys(rand, ITEM_KEYS) as ItemKey[];
    this.boughtThisShop.clear();
    this.renderShop();
    showShop();
    ($('endless-shop-continue') as HTMLButtonElement).onclick = () => {
      hideShop();
      this.nextLevel();
    };
  }

  private renderShop() {
    const wallet = fmt(this.totalCoins);
    const rows = this.shopKeys.map((key) => {
      const def = ITEM_DEFS[key];
      if (this.boughtThisShop.has(key)) {
        return `<div class="shop-item">` +
          `<div class="shop-item-char">${def.char}</div>` +
          `<div class="shop-item-info"><div class="shop-item-name">${def.name}</div><div class="shop-item-desc">${def.desc}</div></div>` +
          `<div class="shop-item-bought">${t('common.bought')}</div>` +
          `</div>`;
      }
      const price = this.priceOf(key);
      const afford = this.totalCoins >= price;
      return `<div class="shop-item">` +
        `<div class="shop-item-char">${def.char}</div>` +
        `<div class="shop-item-info"><div class="shop-item-name">${def.name}</div><div class="shop-item-desc">${def.desc}</div></div>` +
        `<div class="shop-item-price">${fmt(price)}￥</div>` +
        `<button type="button" class="shop-item-buy" data-buy="${key}" ${afford ? '' : 'disabled'}>${t('common.buy')}</button>` +
        `</div>`;
    }).join('');
    const body = $('endless-shop-body');
    body.innerHTML = `<div class="shop-wallet">${t('endless.shopWallet', { coins: wallet })}</div><div class="shop-list">${rows}</div>`;
    body.querySelectorAll<HTMLButtonElement>('[data-buy]').forEach((btn) => {
      btn.onclick = () => this.buyItem(btn.dataset.buy as ItemKey);
    });
  }

  private buyItem(key: ItemKey) {
    if (this.boughtThisShop.has(key)) return;
    const price = this.priceOf(key);
    if (this.totalCoins < price) return;
    this.totalCoins -= price;
    this.boughtThisShop.add(key);
    this.itemPrices.set(key, nextPrice(rand, price)); // 下次购买涨价
    this.addOwned(key);
    this.renderShop();
  }

  private priceOf(key: ItemKey): number {
    const def = ITEM_DEFS[key];
    const existing = this.itemPrices.get(key);
    if (existing !== undefined) return existing;
    const price = randInt(def.min, def.max);
    this.itemPrices.set(key, price);
    return price;
  }

  private addOwned(key: ItemKey) {
    if (key === 'potion') {
      const existing = this.owned.find((o) => o.key === 'potion');
      if (existing) existing.durability += POTION_USES;
      else this.owned.push({ key: 'potion', durability: POTION_USES });
      return;
    }
    this.owned.push({ key, durability: key === 'hourglass' ? HOURGLASS_USES : 1 });
  }

  private nextLevel() {
    this.switching = false;
    this.floatUpCoins();
    this.level += 1;
    this.target = cumulativeTarget(this.level);
    this.levelCoins = 0;
    this.targetHit = false;
    this.collectedThisLevel.clear();
    // 单关道具自动激活：飞花令牌本关随机关键字；美食鉴赏家本关随机 5 种食物
    this.tokenChar = this.hasItem('token') ? pickTokenChar() : '';
    this.tokenMatches = 0;
    this.foodActive = this.hasItem('food');
    this.activeFoods = this.foodActive ? pickInitialFoods() : [];
    this.usedFoods.clear();
    endlessStatus(this.statusHtml());
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.refresh();
    this.renderItems();
    this.renderToken();
    this.renderFoods();
    this.countdown.start(LEVEL_SECONDS, (r) => this.showCountdown(r), () => this.onLevelTimeout());
  }

  private clearLevelItemFx() {
    this.tokenChar = '';
    this.tokenMatches = 0;
    this.revealAllNames = false;
    this.foodActive = false;
    this.activeFoods = [];
    this.usedFoods.clear();
    if (this.revealTimer !== null) {
      window.clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    endlessToken('');
    endlessFood('');
  }

  private gameOver() {
    this.countdown.stop();
    this.ctx.showTimer(null);
    hideLevelEnd();
    hideShop();
    this.clearLevelItemFx();
    this.started = false;
    this.paused = false;
    this.switching = false;
    this.ctx.updateProgress();
    const elapsedMs = this.runStartAt ? Date.now() - this.runStartAt : 0;
    const result: RoundResult = {
      mode: 'endless',
      scopeProvince: null,
      scopeLabel: t('common.nation'),
      totalUnits: 0,
      correct: 0,
      wrong: 0,
      elapsedMs,
      finishedAt: Date.now(),
      coins: this.totalCoins,
      level: this.level,
    };
    this.ctx.showSummary(
      `${t('endless.gameOverTitle')}<div class="sum-stats">${t('endless.gameOverSummary', { level: this.level, coins: fmt(this.totalCoins), count: this.totalCollects, time: formatElapsedSeconds(elapsedMs) })}</div>`,
      () => this.enter(),
      result,
    );
    this.showStartHint();
    endlessStatus('');
    this.ctx.search.clear();
  }

  private statusHtml() {
    return (
      `<span>${t('endless.statusLevel', { level: this.level })}</span>` +
      `<span>${t('endless.statusTarget', { coins: fmt(this.target) })}</span>` +
      `<span>${t('endless.statusTotal', { coins: fmt(this.totalCoins) })}</span>` +
      `<span>${t('endless.statusLevelCoins', { coins: fmt(this.levelCoins) })}</span>`
    );
  }

  private labelOf(adcode: string): { text: string; price: boolean; noBg: boolean } | null {
    // 透视药水：短暂显示全部地名
    if (this.revealAllNames) {
      const u = this.ctx.byAdcode.get(adcode);
      return u ? { text: u.name, price: false, noBg: false } : null;
    }
    const c = this.coins.get(adcode) ?? 0;
    if (!Number.isFinite(c)) return null; // NaN 防御
    if (c > 0) {
      if (this.hidePrices) return null; // 隐藏价格标签
      return { text: fmt(c), price: true, noBg: this.hidePriceBg };
    }
    if (this.collectedThisLevel.has(adcode)) {
      const u = this.ctx.byAdcode.get(adcode);
      return u ? { text: u.name, price: false, noBg: false } : null;
    }
    return null;
  }

  // ---------- 道具效果 ----------

  private hasItem(key: ItemKey) {
    return this.owned.some((o) => o.key === key && o.durability > 0);
  }

  /** 透视药水：方向键使用，显示全国地名标签 3 秒后自动恢复。 */
  private usePotion() {
    const potion = this.owned.find((o) => o.key === 'potion');
    if (!potion || potion.durability <= 0 || this.revealAllNames) return;
    potion.durability -= 1;
    if (potion.durability <= 0) this.owned = this.owned.filter((o) => o.durability > 0);
    this.revealAllNames = true;
    this.renderItems();
    this.refresh();
    if (this.revealTimer !== null) window.clearTimeout(this.revealTimer);
    this.revealTimer = window.setTimeout(() => {
      this.revealTimer = null;
      this.revealAllNames = false;
      // 3 秒后恢复为之前的价格/地名状态（暂停中=已切到其他模式则不重绘，返回时会刷新）
      if (this.started && !this.paused) this.refresh();
    }, POTION_REVEAL_MS);
    this.ctx.toast(t('endless.potionToast'));
  }

  /** 底部道具卡片。 */
  private renderItems() {
    if (!this.started) {
      endlessItems('');
      return;
    }
    const cards = this.owned
      .filter((o) => o.durability > 0)
      .map((o) => {
        const def = ITEM_DEFS[o.key];
        const dur = o.durability > 1 ? `<span class="endless-item-durability">${o.durability}</span>` : '';
        return `<div class="endless-item" data-item="${o.key}" title="${def.name}">${def.char}${dur}</div>`;
      })
      .join('');
    endlessItems(cards);
  }

  /** 飞花令牌关键字卡片。 */
  private renderToken() {
    endlessToken(this.hasItem('token') && this.tokenChar ? `<span>${t('endless.tokenLabel')}</span><b class="token-char">${this.tokenChar}</b>` : '');
  }

  /** 美食鉴赏家：屏幕上方食物卡片（非玻璃态）。 */
  private renderFoods() {
    if (!this.foodActive || !this.activeFoods.length) {
      endlessFood('');
      return;
    }
    endlessFood(this.activeFoods.map((f) => `<div class="food-card" title="${f.province}">${f.food}</div>`).join(''));
  }

  /** 命中当前显示的食物：返回该省份对应的食物。 */
  private foodForUnit(unit: Unit): FoodEntry | null {
    if (!this.foodActive) return null;
    return this.activeFoods.find((f) => f.province === unit.province) ?? null;
  }

  /** 食物作废并替换为另一未使用食物。 */
  private consumeFood(food: FoodEntry) {
    this.activeFoods = this.activeFoods.filter((f) => f !== food);
    this.usedFoods.add(food.food);
    const remaining = FOODS.filter((f) => !this.usedFoods.has(f.food) && !this.activeFoods.some((a) => a.food === f.food));
    if (remaining.length) {
      this.activeFoods.push(remaining[Math.floor(rand() * remaining.length)]);
    }
    this.renderFoods();
  }

  /** 基于柏林噪声生成全国地级市初始金币（约 50-400，多数低于 250，~150 常见）。 */
  private generateCoins(): Map<string, number> {
    const map = new Map<string, number>();
    for (const u of this.ctx.data.units) {
      const n = clamp(
        fbm((u.center[0] + 180) / COIN_NOISE_SCALE, (u.center[1] + 90) / COIN_NOISE_SCALE, 3, this.perm) * COIN_NOISE_AMPLIFY,
        -1,
        1,
      );
      map.set(u.adcode, coinValue(n));
    }
    return map;
  }

  /** 跨关上浮：全部城市（含本关已收集）按当前金币区间取范围内随机值增长。 */
  private floatUpCoins() {
    for (const [adcode, coins] of this.coins) {
      if (!Number.isFinite(coins)) continue; // NaN 防御
      this.coins.set(adcode, coins + floatUpIncrement(rand, coins));
    }
  }
}

// ---------- 本地持久化键 ----------
const HIDE_PRICE_KEY = 'china-admin-endless-hide-price-v1';
const HIDE_PRICE_BG_KEY = 'china-admin-endless-hide-price-bg-v1';

// ---------- 工具 ----------
const rand = Math.random; // 随机源（经济纯函数默认注入 Math.random，测试走 endlessEconomy）

function fmt(n: number) {
  if (!Number.isFinite(n)) return '0'; // NaN 防御
  return Math.round(n).toLocaleString('zh-CN');
}

function randInt(min: number, max: number) {
  return min + Math.floor(rand() * (max - min + 1));
}

function randomSeed() {
  return (Date.now() ^ Math.floor(rand() * 0xffffffff)) >>> 0;
}

function loadHidePrices(): boolean {
  try {
    return localStorage.getItem(HIDE_PRICE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveHidePrices(hidden: boolean) {
  try {
    localStorage.setItem(HIDE_PRICE_KEY, hidden ? '1' : '0');
  } catch {
    /* 忽略存储失败 */
  }
}

function loadHidePriceBg(): boolean {
  try {
    return localStorage.getItem(HIDE_PRICE_BG_KEY) === '1';
  } catch {
    return false;
  }
}

function saveHidePriceBg(hidden: boolean) {
  try {
    localStorage.setItem(HIDE_PRICE_BG_KEY, hidden ? '1' : '0');
  } catch {
    /* 忽略存储失败 */
  }
}
