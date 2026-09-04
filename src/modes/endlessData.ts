import { t } from '../i18n';

/** 无尽闯关道具与美食数据（从 endless.ts 抽出，纯数据 + 少量纯抽取函数）。 */

export type ItemKey = 'hourglass' | 'clover' | 'shield' | 'token' | 'potion' | 'food';

export interface ItemDef {
  key: ItemKey;
  name: string;
  char: string; // 卡片显示的首个汉字
  min: number; // 初始价格下限
  max: number; // 初始价格上限
  desc: string;
}

export interface OwnedItem {
  key: ItemKey;
  durability: number; // 剩余使用次数（沙漏5/药水3；单关道具1）
}

export interface FoodEntry {
  province: string; // 省份全名（与单位 province 一致）
  food: string;
}

export const ITEM_KEYS: ItemKey[] = ['hourglass', 'clover', 'shield', 'token', 'potion', 'food'];

export const ITEM_DEFS: Record<ItemKey, ItemDef> = {
  hourglass: { key: 'hourglass', name: t('endless.item.hourglass.name'), char: t('endless.item.hourglass.char'), min: 100, max: 200, desc: t('endless.item.hourglass.desc') },
  clover: { key: 'clover', name: t('endless.item.clover.name'), char: t('endless.item.clover.char'), min: 100, max: 400, desc: t('endless.item.clover.desc') },
  shield: { key: 'shield', name: t('endless.item.shield.name'), char: t('endless.item.shield.char'), min: 100, max: 400, desc: t('endless.item.shield.desc') },
  token: { key: 'token', name: t('endless.item.token.name'), char: t('endless.item.token.char'), min: 100, max: 400, desc: t('endless.item.token.desc') },
  potion: { key: 'potion', name: t('endless.item.potion.name'), char: t('endless.item.potion.char'), min: 100, max: 400, desc: t('endless.item.potion.desc') },
  food: { key: 'food', name: t('endless.item.food.name'), char: t('endless.item.food.char'), min: 100, max: 400, desc: t('endless.item.food.desc') },
};

export const FOODS: FoodEntry[] = [
  { province: '北京市', food: t('endless.food.北京市') },
  { province: '天津市', food: t('endless.food.天津市') },
  { province: '河北省', food: t('endless.food.河北省') },
  { province: '山西省', food: t('endless.food.山西省') },
  { province: '内蒙古自治区', food: t('endless.food.内蒙古自治区') },
  { province: '辽宁省', food: t('endless.food.辽宁省') },
  { province: '吉林省', food: t('endless.food.吉林省') },
  { province: '黑龙江省', food: t('endless.food.黑龙江省') },
  { province: '上海市', food: t('endless.food.上海市') },
  { province: '江苏省', food: t('endless.food.江苏省') },
  { province: '浙江省', food: t('endless.food.浙江省') },
  { province: '安徽省', food: t('endless.food.安徽省') },
  { province: '福建省', food: t('endless.food.福建省') },
  { province: '江西省', food: t('endless.food.江西省') },
  { province: '山东省', food: t('endless.food.山东省') },
  { province: '河南省', food: t('endless.food.河南省') },
  { province: '湖北省', food: t('endless.food.湖北省') },
  { province: '湖南省', food: t('endless.food.湖南省') },
  { province: '广东省', food: t('endless.food.广东省') },
  { province: '广西壮族自治区', food: t('endless.food.广西壮族自治区') },
  { province: '海南省', food: t('endless.food.海南省') },
  { province: '重庆市', food: t('endless.food.重庆市') },
  { province: '四川省', food: t('endless.food.四川省') },
  { province: '贵州省', food: t('endless.food.贵州省') },
  { province: '云南省', food: t('endless.food.云南省') },
  { province: '西藏自治区', food: t('endless.food.西藏自治区') },
  { province: '陕西省', food: t('endless.food.陕西省') },
  { province: '甘肃省', food: t('endless.food.甘肃省') },
  { province: '青海省', food: t('endless.food.青海省') },
  { province: '宁夏回族自治区', food: t('endless.food.宁夏回族自治区') },
  { province: '新疆维吾尔自治区', food: t('endless.food.新疆维吾尔自治区') },
  { province: '香港特别行政区', food: t('endless.food.香港特别行政区') },
  { province: '澳门特别行政区', food: t('endless.food.澳门特别行政区') },
  { province: '台湾省', food: t('endless.food.台湾省') },
];

/** 飞花令牌候选关键字。 */
export const TOKEN_CHARS = ['州', '阳', '山', '南', '安', '江', '宁', '城', '西', '德', '海'];

/** 随机抽取 5 种不重复食物。 */
export function pickInitialFoods(): FoodEntry[] {
  const pool = [...FOODS];
  const out: FoodEntry[] = [];
  for (let i = 0; i < 5 && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/** 飞花令牌关键字：从固定列表随机抽取。 */
export function pickTokenChar(): string {
  return TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)];
}
