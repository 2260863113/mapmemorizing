import type { Mode, Unit } from '../types';
import type { ModeCtx, ModeController } from './types';
import { Countdown } from '../ui/countdown';
import { $, endlessFood, endlessItems, endlessStatus, endlessToken, flashTimerPenalty, hideLevelEnd, hideShop, showLevelEnd, showShop } from '../ui/dom';
import { formatElapsedSeconds } from '../ui/format';

/**
 * 无尽闯关：
 * 每关限时 45 秒，输入地级市名称收集金币。每关以「时间结束」为结束条件，
 * 结束时累计金币达到累计目标则展示通关卡片，点「继续」进入道具商店；购买道具后再次点「继续」进入下一关。
 * 累计金币跨关保留（购买道具会消耗金币）；每个地级市收集后下一关恢复可再次收集。
 * 初始金币基于柏林噪声生成（约 50-400），相邻地级市平滑过渡。
 * 道具产生的额外金币不超过该地名本身价格。
 */
export class EndlessMode implements ModeController {
  id: Mode = 'endless';
  title = '无尽闯关';
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

  constructor(private ctx: ModeCtx) {
    // 透视药水：任意方向键使用
    document.addEventListener('keydown', (event) => {
      if (!this.started || this.paused || this.switching) return;
      if (event.key.startsWith('Arrow')) this.usePotion();
    });
  }

  enter() {
    if (this.paused) {
      this.syncScope();
      this.ctx.setHint(''); // 清除其他模式遗留的开始卡片
      this.ctx.search.setPlaceholder('输入地名');
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
    this.ctx.search.setPlaceholder('输入地名');
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
    this.ctx.search.setRequireEnter(this.ctx.settings.requireEnter);
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
        this.ctx.toast('盾牌抵挡：输错不扣金币、不扣时间');
        return;
      }
      this.ctx.toast('匹配失败，惩罚时5秒！');
      this.penalize(5);
      this.totalCoins = Math.max(0, this.totalCoins - WRONG_INPUT_COIN_LOSS);
      endlessStatus(this.statusHtml());
      return;
    }
    const value = this.coins.get(best.adcode) ?? 0;
    if (!Number.isFinite(value) || value <= 0) {
      this.ctx.toast('该城市金币本关已收集');
      return;
    }
    this.collect(best, value);
  }

  onInput() {
    /* 无尽闯关必须按 Enter 确认，不做实时输入判定 */
  }

  onUnitClick() {
    return true; // 拦截下钻，固定全国视图
  }

  onUnitDblClick() {
    this.ctx.toast('无尽闯关不支持下钻省份');
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
    const actions = '<button id="endless-start" class="start-action">开始</button>';
    this.ctx.setHint(`<div class="start-panel"><div class="start-title">无尽闯关</div><div class="start-subtitle">范围：全国</div>${actions}</div>`);
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
    this.target = this.cumulativeTarget(1);
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
    if (this.hasItem('clover')) bonus += Math.min(randInt(50, 100), value);
    // 飞花令牌：含关键字的地名额外获得金币，逐次递增（不超过地名本身价格）
    if (this.hasItem('token') && this.tokenChar && this.nameHasToken(unit)) {
      bonus += Math.min(randInt(50, 100) + this.tokenMatches * 50, value);
      this.tokenMatches += 1;
    }
    // 美食鉴赏家：命中食物省份额外 50-100 金币（不超过地名本身价格），随后该食物作废并替换
    let foodBonus = 0;
    const food = this.foodForUnit(unit);
    if (food) {
      foodBonus = Math.min(randInt(50, 100), value);
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
      timeBonus = randInt(3, 5);
      this.countdown.add(timeBonus * 1000);
      hourglass.durability -= 1;
      if (hourglass.durability <= 0) this.owned = this.owned.filter((o) => o.durability > 0);
      this.renderItems();
    }
    this.ctx.search.clear();
    this.ctx.search.focus();
    this.refresh();
    this.ctx.renderer.flash(unit.adcode);
    const extras: string[] = [];
    if (bonus > 0) extras.push(`+${fmt(bonus)}￥加成`);
    if (timeBonus > 0) extras.push(`时间+${timeBonus}秒`);
    const extraTxt = extras.length ? `（${extras.join('，')}）` : '';
    if (!this.targetHit && this.totalCoins >= this.target) {
      this.targetHit = true;
      this.ctx.toast(`已达成目标：${fmt(this.target)}￥，剩余时间可继续收集金币`);
    } else {
      this.ctx.toast(`收集成功：${unit.name} +${fmt(value)}￥${extraTxt}`);
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
      ? `<div class="food-answer"><div class="food-answer-title">美食鉴赏家 · 对应表</div>${FOODS.map(
          (f) => `<div class="food-answer-row"><span>${f.food}</span><span>${f.province}</span></div>`,
        ).join('')}</div>`
      : '';
    showLevelEnd(
      `<div class="level-end-title">第 ${this.level} 关完成</div>` +
        `<div class="sum-stats">累计目标：<b>${fmt(this.target)}￥</b></div>` +
        `<div class="sum-stats">累计收集：<b>${fmt(this.totalCoins)}￥</b></div>` +
        `<div class="sum-stats">本关收集：<b>${fmt(this.levelCoins)}￥</b></div>` +
        foodTable,
      () => this.openShop(),
    );
  }

  /** 道具商店：每件道具 50% 概率出现，每关仅可购买一次。 */
  private openShop() {
    this.switching = true;
    this.shopKeys = ITEM_KEYS.filter(() => Math.random() < 0.5);
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
          `<div class="shop-item-bought">已购买</div>` +
          `</div>`;
      }
      const price = this.priceOf(key);
      const afford = this.totalCoins >= price;
      return `<div class="shop-item">` +
        `<div class="shop-item-char">${def.char}</div>` +
        `<div class="shop-item-info"><div class="shop-item-name">${def.name}</div><div class="shop-item-desc">${def.desc}</div></div>` +
        `<div class="shop-item-price">${fmt(price)}￥</div>` +
        `<button type="button" class="shop-item-buy" data-buy="${key}" ${afford ? '' : 'disabled'}>购买</button>` +
        `</div>`;
    }).join('');
    const body = $('endless-shop-body');
    body.innerHTML = `<div class="shop-wallet">当前金币：<b>${wallet}￥</b></div><div class="shop-list">${rows}</div>`;
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
    this.itemPrices.set(key, price + randInt(80, 120)); // 下次购买涨价
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
    this.target = this.cumulativeTarget(this.level);
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
    this.ctx.showSummary(
      `闯关结束<div class="sum-stats">到达第 <b>${this.level}</b> 关 ｜ 累计金币 <b>${fmt(this.totalCoins)}￥</b> ｜ 收集 <b>${this.totalCollects}</b> 次 ｜ 用时 ${formatElapsedSeconds(elapsedMs)}</div>`,
      () => this.enter(),
    );
    this.showStartHint();
    endlessStatus('');
    this.ctx.search.clear();
  }

  private statusHtml() {
    return (
      `<span>第 <b>${this.level}</b> 关</span>` +
      `<span>本关目标：<b>${fmt(this.target)}￥</b></span>` +
      `<span>累计收集：<b>${fmt(this.totalCoins)}￥</b></span>` +
      `<span>本关收集：<b>${fmt(this.levelCoins)}￥</b></span>`
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

  /** 飞花令牌命中：含关键字的名称命中；「自治州」中的「州」不作数。 */
  private nameHasToken(unit: Unit) {
    if (!this.tokenChar) return false;
    if (this.tokenChar === '州') {
      return unit.name.replace(/自治州/g, '').includes('州') || unit.shortName.includes('州');
    }
    return unit.name.includes(this.tokenChar) || unit.shortName.includes(this.tokenChar);
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
      if (this.started) this.refresh(); // 3 秒后恢复为之前的价格/地名状态
    }, POTION_REVEAL_MS);
    this.ctx.toast('透视药水：显示全国地名标签 3 秒');
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
    endlessToken(this.hasItem('token') && this.tokenChar ? `<span>关键字</span><b class="token-char">${this.tokenChar}</b>` : '');
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
      this.activeFoods.push(remaining[Math.floor(Math.random() * remaining.length)]);
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
      const t = (n + 1) / 2;
      const coins = Math.round((COIN_MIN + t * t * (COIN_MAX - COIN_MIN)) / 10) * 10;
      map.set(u.adcode, Number.isFinite(coins) ? clamp(coins, COIN_MIN, COIN_MAX) : COIN_MIN);
    }
    return map;
  }

  /** 跨关上浮：全部城市（含本关已收集）按当前金币区间取范围内随机值增长。 */
  private floatUpCoins() {
    for (const [adcode, coins] of this.coins) {
      if (!Number.isFinite(coins)) continue; // NaN 防御
      let inc: number;
      if (coins < 100) inc = randInt(30, 50);
      else if (coins < 300) inc = randInt(20, 40);
      else if (coins < 500) inc = randInt(10, 30);
      else inc = randInt(5, 15);
      this.coins.set(adcode, coins + inc);
    }
  }

  /** 本关累计目标：通关所需的累计金币（第一关 1000，第二关 1000+1100=2100，逐关等比求和）。 */
  private cumulativeTarget(level: number) {
    return (BASE_TARGET * (Math.pow(TARGET_GROWTH, level) - 1)) / (TARGET_GROWTH - 1);
  }
}

// ---------- 常量 ----------
const LEVEL_SECONDS = 45;
const BASE_TARGET = 1000; // 第一关累计目标金币
const TARGET_GROWTH = 1.1; // 累计目标每关增幅（第二关 1000+1100=2100）
const COIN_MIN = 50; // 初始金币下限（约 50）
const COIN_MAX = 400; // 初始金币上限（约 400）
const COIN_NOISE_SCALE = 6; // 经/纬度噪声尺度
const COIN_NOISE_AMPLIFY = 1.25; // 噪声起伏放大（拉开差距）
const COIN_LABEL_ZOOM = 2; // 金币标签显示倍率阈值
const HIDE_PRICE_KEY = 'china-admin-endless-hide-price-v1';
const HIDE_PRICE_BG_KEY = 'china-admin-endless-hide-price-bg-v1';
const WRONG_INPUT_COIN_LOSS = 10; // 输错地名扣减的金币（盾牌可免疫）
const HOURGLASS_USES = 5; // 时间沙漏激活后次数
const POTION_USES = 3; // 透视药水使用次数（每购买一次）
const POTION_REVEAL_MS = 3000; // 透视药水显示地名时长
const TOKEN_CHARS = ['州', '阳', '山', '南', '安', '江', '宁', '城', '西', '德', '海']; // 飞花令牌候选关键字

type ItemKey = 'hourglass' | 'clover' | 'shield' | 'token' | 'potion' | 'food';

interface ItemDef {
  key: ItemKey;
  name: string;
  char: string; // 卡片显示的首个汉字
  min: number; // 初始价格下限
  max: number; // 初始价格上限
  desc: string;
}

interface OwnedItem {
  key: ItemKey;
  durability: number; // 剩余使用次数（沙漏5/药水3；单关道具1）
}

interface FoodEntry {
  province: string; // 省份全名（与单位 province 一致）
  food: string;
}

const ITEM_KEYS: ItemKey[] = ['hourglass', 'clover', 'shield', 'token', 'potion', 'food'];

const ITEM_DEFS: Record<ItemKey, ItemDef> = {
  hourglass: { key: 'hourglass', name: '时间沙漏', char: '时', min: 100, max: 200, desc: '每次输入成功，倒计时随机 +3~5 秒（共 5 次）' },
  clover: { key: 'clover', name: '幸运草', char: '幸', min: 100, max: 400, desc: '每次输入成功，随机额外获得 50~100 金币' },
  shield: { key: 'shield', name: '盾牌', char: '盾', min: 100, max: 400, desc: '本关输错地名不再扣金币、不扣时间' },
  token: { key: 'token', name: '飞花令牌', char: '飞', min: 100, max: 400, desc: '包含关键字的地名额外获得金币，逐次递增' },
  potion: { key: 'potion', name: '透视药水', char: '透', min: 100, max: 400, desc: '按方向键使用，显示全国地名标签 3 秒（共 3 次，可跨关携带）' },
  food: { key: 'food', name: '美食鉴赏家', char: '美', min: 100, max: 400, desc: '屏幕上方显示 5 种食物，输入其省份地级市额外获得 50~100 金币' },
};

const FOODS: FoodEntry[] = [
  { province: '北京市', food: '北京烤鸭' },
  { province: '天津市', food: '狗不理包子' },
  { province: '河北省', food: '驴肉火烧' },
  { province: '山西省', food: '刀削面' },
  { province: '内蒙古自治区', food: '手把羊肉' },
  { province: '辽宁省', food: '猪肉炖粉条' },
  { province: '吉林省', food: '延吉冷面' },
  { province: '黑龙江省', food: '锅包肉' },
  { province: '上海市', food: '生煎包' },
  { province: '江苏省', food: '松鼠鳜鱼' },
  { province: '浙江省', food: '西湖醋鱼' },
  { province: '安徽省', food: '臭鳜鱼' },
  { province: '福建省', food: '佛跳墙' },
  { province: '江西省', food: '粉蒸肉' },
  { province: '山东省', food: '九转大肠' },
  { province: '河南省', food: '胡辣汤' },
  { province: '湖北省', food: '热干面' },
  { province: '湖南省', food: '剁椒鱼头' },
  { province: '广东省', food: '白切鸡' },
  { province: '广西壮族自治区', food: '螺蛳粉' },
  { province: '海南省', food: '文昌鸡' },
  { province: '重庆市', food: '牛油火锅' },
  { province: '四川省', food: '麻婆豆腐' },
  { province: '贵州省', food: '酸汤鱼' },
  { province: '云南省', food: '过桥米线' },
  { province: '西藏自治区', food: '酥油茶' },
  { province: '陕西省', food: '羊肉泡馍' },
  { province: '甘肃省', food: '兰州牛肉面' },
  { province: '青海省', food: '酿皮' },
  { province: '宁夏回族自治区', food: '手抓滩羊肉' },
  { province: '新疆维吾尔自治区', food: '大盘鸡' },
  { province: '香港特别行政区', food: '避风塘炒蟹' },
  { province: '澳门特别行政区', food: '葡式蛋挞' },
  { province: '台湾省', food: '三杯鸡' },
];

/** 随机抽取 5 种不重复食物。 */
function pickInitialFoods(): FoodEntry[] {
  const pool = [...FOODS];
  const out: FoodEntry[] = [];
  for (let i = 0; i < 5 && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/** 飞花令牌关键字：从固定列表随机抽取。 */
function pickTokenChar(): string {
  return TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)];
}

// ---------- 工具 ----------
function fmt(n: number) {
  if (!Number.isFinite(n)) return '0'; // NaN 防御
  return Math.round(n).toLocaleString('zh-CN');
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function randInt(min: number, max: number) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
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

// ---------- 柏林噪声（种子化，确定性） ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePermutation(seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = base[i];
    base[i] = base[j];
    base[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  return perm;
}

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function grad2(hash: number, x: number, y: number): number {
  switch (hash & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

function perlin2(x: number, y: number, perm: Uint8Array): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);
  const aa = perm[perm[xi] + yi];
  const ab = perm[perm[xi] + yi + 1];
  const ba = perm[perm[xi + 1] + yi];
  const bb = perm[perm[xi + 1] + yi + 1];
  const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
  const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v);
}

function fbm(x: number, y: number, octaves: number, perm: Uint8Array): number {
  let value = 0;
  let amp = 0.5;
  let freq = 1;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    value += amp * perlin2(x * freq, y * freq, perm);
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return value / max;
}
