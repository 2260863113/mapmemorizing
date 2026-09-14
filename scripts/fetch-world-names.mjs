// 世界国家「英文名 + 首都」数据管线：把 Natural Earth 的国家英文名与首都冻结成一张可审计的表。
//
// 为什么要单独一张表（而不是塞进 countries.json 或硬编码进 src/）：
//   1. countries.json 由世界几何管线产出，它的输出契约被 src 与探针逐字依赖
//      （见 scripts/fetch-world-data-v2.mjs 顶部「countries.json 一行不改」的口径）；
//      「英文名 / 首都」是与几何无关的另一类事实，可以单独重建、单独 diff。
//   2. 首都与国名是会变的：阿斯塔纳 2019 改名努尔苏丹、2022 年 9 月又改回阿斯塔纳；
//      缅甸迁都内比都、斯威士兰改埃斯瓦蒂尼、佛得角英文名改 Cabo Verde……
//      散落在组件里硬编码，下次改名时无从审计；冻结成一个档就变成一条可回滚的数据 diff。
//   3. 源的 NAME_ZH 混有繁体字与台湾译名（本脚本实测：200 条首都里 5 条含繁体专用字、
//      14 条是台湾译名），必须有人工校订。本脚本把**全部人工决定**集中到一张
//      NAME_OVERRIDES 表里，每条带中文理由，并在末尾打印逐条 before→after 供审计。
//
// 关键不变量（违反即中止，或至少大声报告）：
//   1. names 的键**恰好**等于 countries.json 的 iso 集合，不多不少（硬断言）
//   2. 每条 en / capital / capitalEn 都非空（硬断言）
//   3. 源里连不到首都的国家必须在 NAME_OVERRIDES 里补上，否则硬失败（不许静默留空）
//   4. 输出无时间戳、无随机量：同一份源 + 同一份 overrides ⇒ 逐字节相同（末尾打印 sha256 供比对）
//   5. 自检：残留繁体专用字 / 空值 / 跨国重名只 WARNING 不失败（仓库口径：报告，不静默通过）
//
// 输出契约（被 src/worldNames.ts 消费）：
//   public/data/world_names.json
//   { "source": "<一行来源+许可说明>", "names": { "<iso_a3>": { "en", "capital", "capitalEn" } } }
//   单行 JSON.stringify + 结尾换行，与 public/data/world_area.json、subregions.json 一致。
//
// 数据源（两者都是 Natural Earth v5.1.2，公有领域，故冻结入库；
// 本脚本需要网络，但**运行时不依赖网络**）：
//   - 国家英文名：ne_10m_admin_0_countries_chn 的 NAME_EN
//     **必须用 _chn（中国视角）变体**：与几何管线同一档，勿换标准版（标准版把藏南划给印度）。
//     NAME_EN 取的是「常用简称」而不是 FORMAL_EN 全称，个别源值本身就是全称的
//     （中国/美国/密克罗尼西亚）已在校订表 E 组改成通行简称。
//   - 首都：ne_10m_populated_places 里 ADM0CAP=1 的据点，按 ADM0_A3 连回国家面。
//   两个 URL 都走 jsDelivr 的 gh 镜像（本机 raw.githubusercontent.com 经代理 502，理由同几何管线）。
//
// 用法：node scripts/fetch-world-names.mjs [--refresh]
//   --refresh 忽略本地缓存、重新下载（缓存目录：系统临时目录下的 map-memory-world-names，
//   两个源合计约 31MB；命中缓存时重跑是秒级的，且不影响输出字节）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'public', 'data');
const IN_COUNTRIES = path.join(DATA_DIR, 'countries.json');
const OUT_JSON = path.join(DATA_DIR, 'world_names.json');

const SRC_URL_COUNTRIES = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_10m_admin_0_countries_chn.geojson';
const SRC_URL_PLACES = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_10m_populated_places.geojson';

/** 写进 world_names.json 的 source 字段：一行讲清「谁给的 + 什么许可 + 改过什么」。 */
const SOURCE_NOTE = 'Natural Earth v5.1.2（公有领域，https://www.naturalearthdata.com/）：'
  + '国家英文名取 ne_10m_admin_0_countries_chn（中国视角变体）的 NAME_EN，'
  + '首都取 ne_10m_populated_places 中 ADM0CAP=1 据点的 NAME_EN / NAME_ZH；'
  + '繁体字与台湾译名已按大陆通用译名人工校订，逐条理由见 scripts/fetch-world-names.mjs 的 NAME_OVERRIDES。';

/** 源缓存目录：命中则跳过下载。用系统临时目录，不污染仓库。 */
const CACHE_DIR = path.join(os.tmpdir(), 'map-memory-world-names');
const REFRESH = process.argv.includes('--refresh');

// ---------------------------------------------------------------------------
// 人工校订表（**唯一**的人工决定集中处；除本表外，本脚本对名字零硬编码）
// ---------------------------------------------------------------------------
// 每条只写要改的字段（en / capital / capitalEn 三者可选），reason 必填且要写明「为什么」——
// 它是给下一个维护者看的：源换版本、想回滚某条、或质疑某个译名时，答案都在这里。
//
// 分组：
//   A 繁体字 → 简体（源 NAME_ZH 混有繁体，且多是台湾译名）
//   B 源数据缺首都（NRU / PSE / SSD 三国连不上，必须显式补）
//   C 多首都国家（取「中文测验的通行答案」，并把答案钉死以防换档后漂移）
//   D 过长的显示值（缩短到测验口径）
//   E 国家英文名（源给的是正式全称，改用通行简称）
//   F 台湾译名 / 过时地名 → 大陆通用译名（字面是简体，逐字扫描抓不到，只能靠人工）
const NAME_OVERRIDES = {
  // ── A. 繁体字 → 简体 ────────────────────────────────────────────────────
  // 逐字扫描全部 200 条 ADM0CAP=1 的 NAME_ZH，命中繁体专用字的有且仅有这 5 条（见末尾自检）。
  TZA: { capital: '达累斯萨拉姆', reason: 'A 源「三蘭港」是繁体旧称；大陆通用译名达累斯萨拉姆（英文源值 Dar es Salaam 不变）' },
  SYC: { capital: '维多利亚', reason: 'A 源「維多利亞」是繁体；简体为维多利亚' },
  NIC: { capital: '马那瓜', reason: 'A 源「馬拿瓜」是繁体台湾译名；大陆通用译名马那瓜' },
  GTM: { capital: '危地马拉城', reason: 'A 源「瓜地馬拉」是繁体台湾叫法且缺「城」；大陆通用译名危地马拉城，与 countries.json 的国名「危地马拉」同源' },
  CPV: { capital: '普拉亚', reason: 'A 源「培亞」是繁体台湾译名（培亚）；大陆通用译名普拉亚' },

  // ── B. 源数据缺首都 ─────────────────────────────────────────────────────
  // 实测 ADM0CAP=1 共 200 条、覆盖 196 个 ADM0_A3，而答题池 194 国里有 3 国连不上：
  //   NRU 瑙鲁   ：源里没有任何首都据点（瑙鲁不设正式首都，亚伦为政府所在地）
  //   PSE 巴勒斯坦：拉姆安拉在源里是 FEATURECLA='Admin-0 region capital'、ADM0CAP=0
  //   SSD 南苏丹 ：**两个源的 ADM0_A3 不一致**（国家面是 SDS、places 是 SSD）导致连不上；
  //                而且 places 里 Juba 的 ADM0CAP=0（FEATURECLA='Admin-0 capital'）
  // 这三条不写在这里，脚本会硬失败（不允许静默留空）。
  NRU: { capital: '亚伦', capitalEn: 'Yaren', reason: 'B 源无首都据点；瑙鲁不设正式首都，亚伦为政府所在地，中文测验的通行答案' },
  PSE: { capital: '拉马拉', capitalEn: 'Ramallah', reason: 'B 源无 ADM0CAP=1（拉姆安拉是 Admin-0 region capital）；取测验通行写法拉马拉（源译名写作拉姆安拉，消费端别名表可再接受）' },
  SSD: { capital: '朱巴', capitalEn: 'Juba', reason: 'B 两个源的 ADM0_A3 不一致（国家面 SDS / places SSD）导致连不上，且源里 Juba 的 ADM0CAP=0；朱巴为南苏丹首都' },

  // ── C. 多首都国家：取「中文测验的通行答案」 ──────────────────────────────
  // 实测答题池里源返回多个 ADM0CAP=1 的只有 ZAF(3)/BOL(2)/CIV(2)。
  // LKA / NLD 源里只返回一个，但也在这里显式钉住：换源/换档后默认值可能漂移，钉住才算契约。
  ZAF: { capital: '比勒陀利亚', capitalEn: 'Pretoria', reason: 'C 源返回 3 个（布隆方丹/比勒陀利亚/开普敦）；取行政首都比勒陀利亚＝中文测验的通行答案（另两个由消费端当别名收下）' },
  BOL: { capital: '苏克雷', capitalEn: 'Sucre', reason: 'C 源返回 2 个；苏克雷是宪法首都（拉巴斯是政府所在地与最大城市），测验通行答案取苏克雷' },
  CIV: { capital: '亚穆苏克罗', capitalEn: 'Yamoussoukro', reason: 'C 源返回 2 个；亚穆苏克罗是法定首都（阿比让是经济首都与最大城市）' },
  LKA: { capital: '科伦坡', capitalEn: 'Colombo', reason: 'C 源只返回科伦坡；官方首都是斯里贾亚瓦德纳普拉科特，但人们答的是科伦坡，故保留并钉住' },
  NLD: { capital: '阿姆斯特丹', capitalEn: 'Amsterdam', reason: 'C 源只返回阿姆斯特丹；荷兰法定首都是阿姆斯特丹（政府所在地海牙），钉住以免换档漂移' },
  BEN: { capital: '波多诺伏', capitalEn: 'Porto-Novo', reason: 'C 源 ADM0CAP=1 只给科托努；贝宁法定首都是波多诺伏（科托努是政府所在地与最大城市），中文测验通行答案取波多诺伏（科托努由消费端当别名收下）' },

  // ── D. 过长的显示值 ─────────────────────────────────────────────────────
  USA: { en: 'United States', capital: '华盛顿', capitalEn: 'Washington', reason: 'D 源首都为「华盛顿哥伦比亚特区」、国家英文名为正式全称 United States of America；测验口径取 华盛顿 / United States' },
  KIR: { capital: '塔拉瓦', capitalEn: 'Tarawa', reason: 'D 源为 South Tarawa / 南塔拉瓦（塔拉瓦环礁南部人工岛）；测验通行答案取 塔拉瓦 / Tarawa' },

  // ── E. 国家英文名：源给的是正式全称，改用通行简称 ────────────────────────
  CHN: { en: 'China', reason: "E 源 NAME_EN 是正式全称 People's Republic of China；通行简称 China" },
  FSM: { en: 'Micronesia', reason: 'E 源 NAME_EN 是正式名 Federated States of Micronesia；通行简称 Micronesia，与 countries.json 的中文简称「密克罗尼西亚」对应' },

  // ── F. 台湾译名 / 过时地名 → 大陆通用译名 ────────────────────────────────
  // 这些值的字面都是简体（逐字扫描抓不到），但**译名是台湾用法**。
  // 本项目其余答案表（countries.json 的中文名）全是大陆口径；若沿用台湾译名，
  // 大陆用户写出通行译名会被判错——消费端只接受 world_names.json 的值 + 别名表。
  SOM: { capital: '摩加迪沙', reason: 'F 源「摩加迪休」是台湾译名；大陆通用译名摩加迪沙' },
  SAU: { capital: '利雅得', reason: 'F 源「利雅德」是台湾译名；大陆通用译名利雅得' },
  RWA: { capital: '基加利', reason: 'F 源「吉佳利」是台湾译名；大陆通用译名基加利' },
  JAM: { capital: '金斯敦', reason: 'F 源「京斯敦」是台湾译名；大陆通用译名金斯敦（注意：与 VCT 的中文首都名重名，见末尾自检）' },
  DOM: { capital: '圣多明各', reason: 'F 源「圣多明哥」是台湾译名；大陆通用译名圣多明各' },
  MMR: { capital: '内比都', reason: 'F 源「奈比多」是台湾译名；大陆通用译名内比都' },
  BWA: { capital: '哈博罗内', reason: 'F 源「嘉柏隆里」是台湾译名；大陆通用译名哈博罗内' },
  SWZ: { capital: '姆巴巴内', reason: 'F 源「墨巴本」是台湾译名；大陆通用译名姆巴巴内（埃斯瓦蒂尼/斯威士兰的行政首都）' },
  LIE: { capital: '瓦杜兹', reason: 'F 源「瓦都兹」是台湾译名；大陆通用译名瓦杜兹' },
  BLZ: { capital: '贝尔莫潘', reason: 'F 源「贝尔墨邦」是台湾译名；大陆通用译名贝尔莫潘' },
  CRI: { capital: '圣何塞', reason: 'F 源「圣荷西」是台湾译名；大陆通用译名圣何塞' },
  GMB: { capital: '班珠尔', reason: 'F 源「班竹」是台湾译名；大陆通用译名班珠尔' },
  DJI: { capital: '吉布提', reason: 'F 源「吉布地」是台湾译名；大陆通用译名吉布提（与国名同形，消费端按「国名/首都」分段隔离，不冲突）' },
  KAZ: { capital: '阿斯塔纳', capitalEn: 'Astana', reason: 'F 源还是 Nur-Sultan / 努尔苏丹（2019–2022 年的旧名）；2022 年 9 月已改回阿斯塔纳 / Astana' },
};

// ---------------------------------------------------------------------------
// 自检用的「繁体专用字」小表
// ---------------------------------------------------------------------------
// 这些字在简体中文里被换成了另一个码位（蘭/兰、維/维、馬/马…），出现即说明源值是繁体。
// 该表已用**本仓库全部简体文本**（src/、scripts/、*.md，约 118 万字符）反查过假阳性：
// 凡在简体语料里出现过的字都已剔除（素、索、著、警、虞 等），因此命中即真命中。
// 注意它**只用于报告**：残留繁体字时只 WARNING，不失败（仓库口径：报告，不静默通过）。
const TRAD_ONLY_CHARS = '蘭維爾亞魯馬華區國島灣內東車門開關長雲會賽貝頁風飛鳥魚豬雞鴨鵝鷹麥黃點畫當帶專屬標題價錢銀銅鐵鋼輪轉運動進遠邊適選聲書寫讀語詞彙議論證據為與舉舊豐農場園藝樹葉綠紅絲線織結繼續斷羅聖們個來這說麼樣時實際發現產業業務員團體戰擊傳債傷儀億偵傾僅儲兒兩冊剛創劉劍勁勞勢勳匯協單衛卻廠歷壓縣參雙變疊號隻嘆嚴囑圖構檔檢欄權條萬醜處術緬臘猶獨峽級給統綜緊縮練綏網編緣縫績繞繪繫纖計訂訊記講許訟設訪評譯誠話認誰課調談請諾謝護貞負財貢貧貨販貪貫責貴買貸費貼賀資賓賞賠賢賣賤賦質購贈贊贏軌軍軒軟軸載較輔輕輛輝輸馮馭馳驅駕駐騎騙驚驗鮮鯨鳴鴉鶴偽傑儉兇兌茲養獸沖決況淚淨湧湯溝滅滄滬濱濤瀉瀾爐爭愛爺牆犧獎瑪環礦禮禱積稱穀窩筆節範築簡簽籃糧紀約紋納純紙紛細終組絕統經綱緊緒線緩締縱總纔罰罷義習聞聯聰聲職聽肅腎腦腳腸膚臉緻艙艦艱萊藥虛蟲衝補裝裏製複褲覺覽觀討訓訴診註証試詩詳誤諸謀諧諷識譜讎讚賜賬贓贖輩輯轄轎轟軋';
const TRAD_SET = new Set(TRAD_ONLY_CHARS.split(''));

/** 末尾「最需要人工过目的 20 行」：微国 / 多首都 / 人工改过 / 源缺失，只用于报告。 */
const RISK_ROWS = [
  ['NRU', '微国，源里连不到首都（人工补亚伦）'],
  ['PSE', '源里没有 ADM0CAP=1（人工补拉马拉，源译名是拉姆安拉）'],
  ['SSD', '两个源的 ADM0_A3 不一致（SDS / SSD），人工补朱巴'],
  ['BEN', '源给科托努；法定首都是波多诺伏（科托努是政府所在地与最大城市）→ 取波多诺伏，科托努由消费端别名收下'],
  ['PLW', '微国，源给梅莱凯奥克（2006 年起政府驻地在 Ngerulmud，源未跟进）'],
  ['JAM', '源「京斯敦」→ 金斯敦，与 VCT 中文名同形（消费端首都档接受同形名，两国都答得出）'],
  ['VCT', '微国，中文首都名与 JAM 同形（金斯敦；消费端首都档接受同形名）'],
  ['LIE', '源「瓦都兹」→ 瓦杜兹'],
  ['KAZ', '源仍是旧名努尔苏丹 → 阿斯塔纳'],
  ['ZAF', '三首都，取行政首都比勒陀利亚'],
  ['BOL', '两首都，取宪法首都苏克雷（拉巴斯是政府所在地）'],
  ['CIV', '两首都，取法定首都亚穆苏克罗'],
  ['LKA', '官方首都（斯里贾亚瓦德纳普拉科特）≠ 通行答案（科伦坡）'],
  ['NLD', '法定首都阿姆斯特丹 / 政府所在地海牙'],
  ['TZA', '源「三蘭港」为繁体旧称；官方首都是多多马，取通行答案达累斯萨拉姆'],
  ['USA', '源「华盛顿哥伦比亚特区」→ 华盛顿；英文名全称 → United States'],
  ['CHN', "源 NAME_EN 是正式全称 People's Republic of China → China"],
  ['GTM', '源「瓜地馬拉」为繁体台湾叫法 → 危地马拉城'],
  ['CPV', '源「培亞」为繁体台湾译名 → 普拉亚'],
  ['SYC', '源「維多利亞」为繁体 → 维多利亚'],
];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 下载并 JSON.parse；带本地缓存（按 URL 校验），失败重试 3 次。 */
async function fetchCached(url) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, path.basename(new URL(url).pathname));
  const urlFile = `${file}.url`;
  const cached = !REFRESH && fs.existsSync(file) && fs.existsSync(urlFile)
    && fs.readFileSync(urlFile, 'utf8').trim() === url;
  if (cached) {
    console.log(`  命中缓存 ${file}（${(fs.statSync(file).size / 1048576).toFixed(1)}MB，加 --refresh 可强制重下）`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (world-names-builder/1.0)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      fs.writeFileSync(urlFile, url);
      console.log(`  下载 ${(buf.length / 1048576).toFixed(1)}MB → ${file}`);
      return JSON.parse(buf.toString('utf8'));
    } catch (e) {
      lastErr = e;
      await sleep(600 * (i + 1));
    }
  }
  throw new Error(`下载失败 ${url}：${lastErr?.message ?? lastErr}`);
}

/** iso 取值规则：与几何管线逐字一致（ISO_A3 为 '-99' 时回退 ADM0_A3），否则两国对不上。 */
function isoOf(p) {
  const a = String(p.ISO_A3 ?? '');
  if (a && a !== '-99') return a;
  return String(p.ADM0_A3 ?? '');
}

/** 多首都时取「最有代表性」的一个：人口最多者（并列时按英文名升序），保证确定性。 */
function pickMostProminent(caps) {
  return [...caps].sort((a, b) => {
    const d = Number(b.POP_MAX ?? 0) - Number(a.POP_MAX ?? 0);
    if (d !== 0) return d;
    return String(a.NAME_EN ?? '').localeCompare(String(b.NAME_EN ?? ''), 'en');
  })[0];
}

function fieldOf(iso, field) {
  return `${iso}.${field}`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
console.log('[1/5] 读取 countries.json（答题池权威清单，本脚本不改写它）...');
if (!fs.existsSync(IN_COUNTRIES)) throw new Error('缺 public/data/countries.json（答题池权威清单）');
const pool = JSON.parse(fs.readFileSync(IN_COUNTRIES, 'utf8')).countries;
const poolIso = pool.map((c) => c.iso);
const poolSet = new Set(poolIso);
const zhByIso = new Map(pool.map((c) => [c.iso, c.name]));
if (poolSet.size !== poolIso.length) throw new Error('countries.json 的 iso 有重复');
console.log(`  答题池 ${poolIso.length} 国（iso 唯一）`);

console.log('[2/5] 下载 Natural Earth v5.1.2（国家英文名 + 据点首都）...');
const neCountries = await fetchCached(SRC_URL_COUNTRIES);
const nePlaces = await fetchCached(SRC_URL_PLACES);
const capFeatures = nePlaces.features.filter((f) => Number(f.properties?.ADM0CAP) === 1);
console.log(`  国家面 ${neCountries.features.length} | 据点 ${nePlaces.features.length} | 其中 ADM0CAP=1 共 ${capFeatures.length}`);

console.log('[3/5] 连表：iso → NAME_EN；ADM0_A3 → ADM0CAP=1 ...');
const countryProps = new Map();
for (const f of neCountries.features) {
  const iso = isoOf(f.properties ?? {});
  if (!countryProps.has(iso)) countryProps.set(iso, f.properties ?? {});
}
const capsByAdm0 = new Map();
for (const f of capFeatures) {
  const p = f.properties ?? {};
  const adm0 = String(p.ADM0_A3 ?? '');
  if (!capsByAdm0.has(adm0)) capsByAdm0.set(adm0, []);
  capsByAdm0.get(adm0).push(p);
}

const names = {};
const noCapSource = []; // 源里连不到首都的国家（必须由校订表补）
const multiSource = []; // 源里返回多个 ADM0CAP=1 的国家（候选，供复核）
const tradHits = [];    // 源值里含繁体专用字的条目

// 按 iso 升序建键：让输出顺序不依赖 countries.json 的书写顺序，逐字节更稳。
for (const iso of [...poolIso].sort()) {
  const p = countryProps.get(iso);
  if (!p) throw new Error(`Natural Earth 里找不到答题国 ${iso}（iso 取值规则或源已变）`);
  const adm0 = String(p.ADM0_A3 ?? '');
  const caps = capsByAdm0.get(adm0) ?? [];
  let capital = '';
  let capitalEn = '';
  if (caps.length === 0) {
    noCapSource.push(iso);
  } else {
    if (caps.length > 1) multiSource.push([iso, caps.map((c) => `${c.NAME_ZH}/${c.NAME_EN}`)]);
    const pick = pickMostProminent(caps);
    capital = String(pick.NAME_ZH ?? '').trim();
    capitalEn = String(pick.NAME_EN ?? '').trim();
  }
  names[iso] = { en: String(p.NAME_EN ?? '').trim(), capital, capitalEn };
  for (const [field, value] of [['en', names[iso].en], ['capital', capital], ['capitalEn', capitalEn]]) {
    const hit = [...value].filter((ch) => TRAD_SET.has(ch));
    if (hit.length) tradHits.push(`${fieldOf(iso, field)} «${value}» 含繁体专用字 ${hit.join('')}`);
  }
}
console.log(`  iso → en：${Object.keys(names).length} 条 | 源里连不到首都 ${noCapSource.length} 国（${noCapSource.join(',') || '无'}）`
  + ` | 源里多首都 ${multiSource.length} 国`);

console.log('[4/5] 套用人工校订表 NAME_OVERRIDES ...');
const changes = [];
const overriddenIso = new Set();
for (const [iso, ov] of Object.entries(NAME_OVERRIDES)) {
  if (!poolSet.has(iso)) throw new Error(`NAME_OVERRIDES 里的 ${iso} 不在答题池里（错别字？还是国家已下线？）`);
  if (!ov.reason || !String(ov.reason).trim()) throw new Error(`NAME_OVERRIDES.${iso} 缺 reason（每条人工决定都必须写明理由）`);
  overriddenIso.add(iso);
  for (const field of ['en', 'capital', 'capitalEn']) {
    if (ov[field] === undefined) continue;
    const before = names[iso][field];
    const after = String(ov[field]).trim();
    if (before !== after) changes.push({ iso, field, before, after, reason: ov.reason });
    names[iso][field] = after;
  }
}
const pinned = [...overriddenIso].filter((iso) => !changes.some((c) => c.iso === iso));
console.log(`  校订 ${overriddenIso.size} 国：实际改动 ${changes.length} 处，显式钉住（与源一致）${pinned.length} 国（${pinned.join(',') || '无'}）`);

console.log('[5/5] 断言 → 写档 → 校验报告 ...');

// ---------- 硬断言（失败即中止） ----------
{
  const errs = [];
  // ① 键集合必须与 countries.json 的 iso 集合完全相同（多一个/少一个都算错）
  const outIso = Object.keys(names);
  const missing = [...poolSet].filter((i) => !(i in names));
  const extra = outIso.filter((i) => !poolSet.has(i));
  if (outIso.length !== poolIso.length) errs.push(`条目数 ${outIso.length} ≠ countries.json 的 ${poolIso.length}`);
  if (missing.length) errs.push(`缺 iso：${missing.join(',')}`);
  if (extra.length) errs.push(`多出 iso：${extra.join(',')}`);
  // ② 三个字段都不许空 / undefined / null
  const blanks = [];
  for (const [iso, v] of Object.entries(names)) {
    for (const field of ['en', 'capital', 'capitalEn']) {
      if (typeof v[field] !== 'string' || !v[field].trim()) blanks.push(fieldOf(iso, field));
    }
  }
  if (blanks.length) errs.push(`空值/非字符串：${blanks.join(', ')}`);
  // ③ 源里连不到首都的国家必须在校订表里补上，否则不许静默留空
  const unfilled = noCapSource.filter((iso) => !NAME_OVERRIDES[iso]?.capital);
  if (unfilled.length) errs.push(`源里连不到首都且未在 NAME_OVERRIDES 补：${unfilled.join(',')}`);
  if (errs.length) {
    console.error('\n✗ 断言失败：');
    for (const e of errs) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('  ✓ 断言：键集合与 countries.json 完全相同 / 无空值 / 缺首都已被校订表补齐');
}

// ---------- 写档 ----------
// 键按 iso 升序插入 → JSON.stringify 保序 → 输出字节只取决于源 + 校订表。
const doc = { source: SOURCE_NOTE, names };
fs.mkdirSync(DATA_DIR, { recursive: true });
const text = JSON.stringify(doc) + '\n';
fs.writeFileSync(OUT_JSON, text, 'utf8');
const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
console.log(`  写出 ${path.relative(ROOT, OUT_JSON)} | ${(Buffer.byteLength(text) / 1024).toFixed(1)}KB | sha256 ${sha.slice(0, 16)}…（无时间戳，重跑应逐字节相同）`);

// ---------- 自检（只报告，不失败） ----------
const back = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
const warns = [];
{
  // ① 残留繁体专用字（源里的繁体在 A 组修掉后应为 0）
  const left = [];
  for (const [iso, v] of Object.entries(back.names)) {
    for (const [field, value] of [['en', v.en], ['capital', v.capital], ['capitalEn', v.capitalEn]]) {
      const hit = [...value].filter((ch) => TRAD_SET.has(ch));
      if (hit.length) left.push(`${fieldOf(iso, field)} «${value}» → ${hit.join('')}`);
    }
  }
  if (left.length) warns.push(`残留繁体专用字 ${left.length} 条：\n      ${left.join('\n      ')}`);
  // ② 空值（硬断言已挡住，这里再报一次是为了「报告，不静默通过」）
  const blanks = [];
  for (const [iso, v] of Object.entries(back.names)) {
    for (const field of ['en', 'capital', 'capitalEn']) if (!String(v[field] ?? '').trim()) blanks.push(fieldOf(iso, field));
  }
  if (blanks.length) warns.push(`空值 ${blanks.length} 条：${blanks.join(', ')}`);
  // ③ 跨国重名：**国名档**（`WorldMatcher.bestMatch`）会把重名写法从两国都剔除（避免歧义命中），
  //    所以国名/英文名重名必须报出来。**首都档**（`acceptsCapital`）不剔除 —— 判据是"这个输入是不是
  //    这一题的名字"，同形异国（JAM/VCT 的「金斯敦」）两国都算对，故首都重名只是提示、不是缺陷。
  const dup = (field) => {
    const by = new Map();
    for (const [iso, v] of Object.entries(back.names)) {
      const k = v[field];
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(iso);
    }
    return [...by.entries()].filter(([, isos]) => isos.length > 1);
  };
  for (const field of ['en', 'capital', 'capitalEn']) {
    const d = dup(field);
    if (d.length) warns.push(`${field} 跨国重名 ${d.length} 组：${d.map(([k, isos]) => `«${k}» ${isos.join('/')}`).join('；')}`);
  }
  // ④ 国名 == 首都名（题面与答案同形，答题时靠「国名/首都」分段隔离，列出以便复核）
  const samePairs = Object.entries(back.names)
    .filter(([iso, v]) => v.capital === (zhByIso.get(iso) ?? ''))
    .map(([iso]) => iso);
  if (samePairs.length) warns.push(`国名与首都中文名同形 ${samePairs.length} 国：${samePairs.join(',')}（消费端按「国名/首都」分段隔离，不冲突，仅列出）`);
}

// ---------- 校验报告 ----------
const n = Object.keys(back.names).length;
console.log('\n================ 校验报告 ================');
console.log(`  条目数        : ${n}（countries.json 的 iso 数 ${poolIso.length}，键集合完全相同 = ${n === poolIso.length && poolIso.every((i) => i in back.names)}）`);
console.log(`  来自源原值    : ${n - overriddenIso.size} 条`);
console.log(`  来自校订表    : ${overriddenIso.size} 条（其中实际改动 ${changes.length} 处）`);
console.log(`  源值含繁体字  : ${tradHits.length} 条（已在校订表 A 组全部修掉，修后残留 ${warns.some((w) => w.startsWith('残留')) ? '有' : '0'}）`);
console.log(`  输出 sha256   : ${sha}`);

console.log(`\n  ── 校订表逐条 before → after（${n} 条中的 ${overriddenIso.size} 条）──`);
for (const iso of Object.keys(NAME_OVERRIDES)) {
  const mine = changes.filter((c) => c.iso === iso);
  const head = `  ${iso} ${zhByIso.get(iso)}`;
  if (!mine.length) {
    console.log(`${head}｜钉住不改：${back.names[iso].capital} / ${back.names[iso].capitalEn}｜${NAME_OVERRIDES[iso].reason}`);
    continue;
  }
  for (const c of mine) {
    console.log(`${head}｜${c.field}: ${c.before || '(源缺)'} → ${c.after}｜${c.reason}`);
  }
}

console.log('\n  ── 源数据缺口 / 多值（供复核）──');
console.log(`  源里连不到首都（无 ADM0CAP=1）：${noCapSource.length} 国 → ${noCapSource.map((i) => `${i}（${back.names[i].capital}）`).join('、') || '无'}`);
if (multiSource.length) {
  for (const [iso, list] of multiSource) {
    console.log(`  源返回多个首都：${iso}（${list.join(' ; ')}）→ 取 ${back.names[iso].capital}`);
  }
} else {
  console.log('  源返回多个首都：无');
}

console.log('\n  ── 最需要人工过目的 20 行（读回最终文件后打印）──');
for (const [iso, why] of RISK_ROWS) {
  const v = back.names[iso];
  if (!v) {
    console.log(`  ${iso} !! 不在输出里`);
    continue;
  }
  console.log(`  ${iso} ${zhByIso.get(iso)}｜${v.en}｜${v.capital} / ${v.capitalEn}｜${why}`);
}

console.log('\n  ── 自检（只报告，不失败）──');
if (warns.length === 0) console.log('  ✓ 无残留繁体字 / 无空值 / 无跨国重名');
else for (const w of warns) console.log(`  ⚠ WARNING: ${w}`);

console.log(`\n  注：本脚本不改写 countries.json；繁体/译名的人工决定全部集中在 NAME_OVERRIDES。`);
