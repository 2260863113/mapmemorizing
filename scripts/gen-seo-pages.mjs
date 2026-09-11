// 生成搜索引擎落地页（SEO）：34 个省级页 + 世界目录页 + 6 个大洲页 + 次区域页 + 404.html。
//
// 为什么需要这个脚本（而不是手写死 HTML）：
//   1. 本站是纯客户端渲染 SPA，dist/index.html 里没有任何地名——蜘蛛（尤其百度）拿到的正文接近零。
//      落地页是**唯一**能让爬虫读到真文本的手段（见 docs/adr/0004 的 SEO 决策）。
//   2. 地名清单必须与 countries.json / units.json **完全吻合**，否则会被判「落地页与应用内容不一致」
//      （作弊嫌疑）。故本脚本从数据源生成，并用断言守护一致性——手写 HTML 会随数据变化而腐烂。
//
// 产出（全部写在 public/ 下，由 Vite 原样拷贝进 dist/）：
//   public/china/index.html            中国各省目录
//   public/china/<slug>/index.html     34 个省级页（含该省全部地级市清单）
//   public/world/index.html            世界各大洲目录
//   public/world/<continent>/index.html  6 个大洲页（含国家清单 + 次区域入口）
//   public/world/<continent>/<sub>/index.html  次区域页（分区数 > 1 的大洲）
//   public/404.html                    Cloudflare Pages 真 404（关掉 SPA fallback 的硬性前提）
//   public/robots.txt / public/sitemap.xml
//
// 用法：node scripts/gen-seo-pages.mjs
// 接入：npm run build 之前自动执行（见 package.json 的 build 脚本）

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SITE = 'https://mapmemory.cn';
const BRAND = '地图记忆';
const TAGLINE = '中国行政区和世界国家记忆助手';

// ==================== 省级 slug 映射（34 条，逐条人工审定）====================
// 为什么手写而不是自动转拼音：slug 是**永久 SEO 资产**（改 URL 等于放弃已有收录），
// 而当前数据源里没有拼音字段（units.json 的 provinces 只有 adcode/name/center）。
// 34 条省一级无多音字争议，逐条核对比引入 pinyin 依赖更可控。
const PROVINCE_SLUG = {
  '110000': 'beijing', '120000': 'tianjin', '130000': 'hebei', '140000': 'shanxi',
  '150000': 'neimenggu', '210000': 'liaoning', '220000': 'jilin', '230000': 'heilongjiang',
  '310000': 'shanghai', '320000': 'jiangsu', '330000': 'zhejiang', '340000': 'anhui',
  '350000': 'fujian', '360000': 'jiangxi', '370000': 'shandong', '410000': 'henan',
  '420000': 'hubei', '430000': 'hunan', '440000': 'guangdong', '450000': 'guangxi',
  '460000': 'hainan', '500000': 'chongqing', '510000': 'sichuan', '520000': 'guizhou',
  '530000': 'yunnan', '540000': 'xizang', '610000': 'shaanxi', '620000': 'gansu',
  '630000': 'qinghai', '640000': 'ningxia', '650000': 'xinjiang', '710000': 'taiwan',
  '810000': 'hongkong', '820000': 'macau',
};

/** 大洲 id → slug（英文名，比拼音更通用，也避免与省级 slug 冲突）。 */
const CONTINENT_SLUG = {
  AS: 'asia', EU: 'europe', AF: 'africa', NA: 'north-america', SA: 'south-america', OC: 'oceania',
};

/** 次区域 id → slug。 */
const SUBREGION_SLUG = {
  EAS: 'east-asia', SEA: 'southeast-asia', SAS: 'south-asia', WAS: 'west-asia', CAS: 'central-asia',
  NEU: 'northern-europe', WEU: 'western-europe', CEU: 'central-europe', EEU: 'eastern-europe', SEU: 'southern-europe',
  NAF: 'north-africa', WAF: 'west-africa', MAF: 'middle-africa', EAF: 'east-africa', SAF: 'southern-africa',
  NAM: 'northern-america', CAM: 'central-america', CAR: 'caribbean',
  SAM: 'south-america',
  ANZ: 'australasia', MEL: 'melanesia', MIC: 'micronesia', POL: 'polynesia',
};

// ==================== 加载数据 ====================

const unitsRaw = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'units.json'), 'utf8'));
const countriesRaw = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'countries.json'), 'utf8'));
const subRaw = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'subregions.json'), 'utf8'));

const provinces = unitsRaw.provinces;
/** 真实记忆单位（剔除装饰面），按省分组。 */
const realUnits = unitsRaw.units.filter((u) => !u.decorative);
const countries = countriesRaw.countries;
const subregions = subRaw.subregions;
const byIso = subRaw.byIso;

// ==================== 断言：页面内容必须与数据源一致 ====================

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

// A. slug 全覆盖
const missingSlug = provinces.filter((p) => !PROVINCE_SLUG[p.adcode]);
if (missingSlug.length) fail('缺少省级 slug：' + missingSlug.map((p) => p.name).join(','));
if (Object.keys(PROVINCE_SLUG).length !== provinces.length) fail('省级 slug 条数与省级单元数不一致');
for (const c of subregions) if (!SUBREGION_SLUG[c.id]) fail(`缺少次区域 slug：${c.id}`);
for (const id of ['AS', 'EU', 'AF', 'NA', 'SA', 'OC']) if (!CONTINENT_SLUG[id]) fail(`缺少大洲 slug：${id}`);

// B. slug 唯一（两个省共用一个 slug 会让其中一个页面被另一个覆盖）
for (const [label, map] of [['省级', PROVINCE_SLUG], ['大洲', CONTINENT_SLUG], ['次区域', SUBREGION_SLUG]]) {
  const vals = Object.values(map);
  if (new Set(vals).size !== vals.length) fail(`${label} slug 存在重复`);
}

// C. 核心一致性断言：页面上的国家清单必须与 countries.json 完全吻合
//    （逐个大洲比对 iso 集合；这是「落地页不与应用内容打架」的机器保证）
for (const continent of Object.keys(CONTINENT_SLUG)) {
  const inData = countries.filter((c) => c.continent === continent).map((c) => c.iso).sort();
  const subs = subregions.filter((s) => s.continent === continent);
  const viaSubs = Object.keys(byIso)
    .filter((iso) => subs.some((s) => s.id === byIso[iso]))
    .sort();
  if (inData.join(',') !== viaSubs.join(',')) {
    fail(`大洲 ${continent} 的国家清单与次区域映射不一致`);
  }
}

// D. 每个国家恰好属于一个次区域，且该次区域存在
for (const c of countries) {
  const sr = byIso[c.iso];
  if (!sr) fail(`国家 ${c.iso} 无次区域`);
  if (!subregions.some((s) => s.id === sr)) fail(`国家 ${c.iso} 的次区域 ${sr} 未声明`);
}

// E. 省级页必须有真实地级单位（否则是空壳薄页）
for (const p of provinces) {
  const n = realUnits.filter((u) => u.provinceAdcode === p.adcode).length;
  if (n === 0) fail(`省级页 ${p.name}(${p.adcode}) 没有地级单位，会是空壳页`);
}

// F. 地级单位总数守恒（写进落地页正文的数字不能是编的）
const unitTotal = realUnits.length;

// ==================== HTML 渲染 ====================

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** 统一的 <head>：每页独立 title/description/canonical，不共用。 */
function head({ title, description, canonical, keywords }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
${keywords ? `<meta name="keywords" content="${esc(keywords)}" />` : ''}
<meta name="robots" content="index,follow" />
<link rel="canonical" href="${SITE}${canonical}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="${BRAND}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${SITE}${canonical}" />
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 24px 16px 64px; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1.75; max-width: 860px; margin-inline: auto; color: #1f2937; background: #f8fafc; }
@media (prefers-color-scheme: dark) { body { color: #e5e7eb; background: #0f172a; } a { color: #93c5fd; } }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 28px 0 10px; }
.sub { opacity: .7; font-size: 14px; margin: 0 0 20px; }
.crumbs { font-size: 13px; opacity: .75; margin-bottom: 14px; }
.crumbs a { text-decoration: none; }
.cta { display: inline-block; margin: 6px 10px 6px 0; padding: 9px 18px; border-radius: 8px; background: #2563eb; color: #fff; text-decoration: none; font-weight: 600; }
.cta.ghost { background: transparent; border: 1px solid currentColor; color: inherit; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 14px; padding: 0; list-style: none; }
.grid li { font-size: 14px; }
.card { border: 1px solid rgba(128,128,128,.28); border-radius: 10px; padding: 14px 18px; margin: 10px 0; }
footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid rgba(128,128,128,.28); font-size: 13px; opacity: .75; }
</style>
</head>
<body>`;
}

const footer = `<footer>
<p><a href="/">${BRAND}</a> · <a href="/china/">中国各省</a> · <a href="/world/">世界各大洲</a> · <a href="/">开始练习</a></p>
<p>${BRAND} - ${TAGLINE}。中国行政区与世界国家地图记忆助记工具，完全免费、无需注册即可练习。</p>
</footer>
</body>
</html>
`;

function write(rel, html) {
  const file = path.join(PUBLIC, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

const written = [];

/** 深链：把浏览器送到 SPA 的对应视图（Q26 的 URL 参数）。 */
const deepLink = (query) => (query ? `/?${query}` : '/');
const subregionHref = (continentId, subId) => `/world/${CONTINENT_SLUG[continentId]}/${SUBREGION_SLUG[subId]}/`;

// ---------- 中国目录页 ----------
{
  const list = provinces
    .map((p) => {
      const n = realUnits.filter((u) => u.provinceAdcode === p.adcode).length;
      return `<li><a href="/china/${PROVINCE_SLUG[p.adcode]}/">${esc(p.name.replace(/(省|市|自治区|特别行政区|壮族|回族|维吾尔|)$/u, '') || p.name)}</a>（${n} 个地级）</li>`;
    })
    .join('\n');
  const title = `中国省级行政区一览 - 全国 ${provinces.length} 个省级行政区与 ${unitTotal} 个地级行政区 | ${BRAND}`;
  const description = `中国全部 ${provinces.length} 个省级行政区（含港澳台）与 ${unitTotal} 个地级行政区的完整清单与地图记忆练习。逐省查看地级市列表，用地图记忆快速记住中国省市位置。`;
  written.push(
    write(
      'china/index.html',
      head({ title, description, canonical: '/china/', keywords: '中国行政区,中国省份,中国地级市,行政区划,地图记忆' }) +
        `<h1>中国省级行政区一览</h1>
<p class="sub">${provinces.length} 个省级行政区 · ${unitTotal} 个地级行政区</p>
<div class="crumbs"><a href="/">${BRAND}</a> › 中国各省</div>
<p>中国共有 <strong>${provinces.length}</strong> 个省级行政区，包括 23 个省、5 个自治区、4 个直辖市和 2 个特别行政区。其下划分为 <strong>${unitTotal}</strong> 个地级行政区（地级市、自治州、地区、盟，以及北京、上海、天津、重庆、香港、澳门、台湾等整体单位）。</p>
<p>点击下方任一省份，可以看到该省全部地级行政区的名称清单，并在「地图记忆」中针对该省开始专项练习。</p>
<a class="cta" href="${deepLink('g=province')}">在 ${BRAND} 练习省级全国</a>
<a class="cta ghost" href="${deepLink('g=city')}">练习全国地级市</a>
<h2>各省份与地级行政区数量</h2>
<ul class="grid">
${list}
</ul>` +
        footer,
    ),
  );
}

// ---------- 34 个省级页 ----------
for (const p of provinces) {
  const slug = PROVINCE_SLUG[p.adcode];
  const cities = realUnits.filter((u) => u.provinceAdcode === p.adcode);
  const short = p.name.replace(/(省|市|自治区|特别行政区)$/u, '') || p.name;
  const list = cities.map((c) => `<li>${esc(c.name)}</li>`).join('\n');
  const title = `${short}地图记忆 - ${p.name}全部 ${cities.length} 个地级行政区练习 | ${BRAND}`;
  const description = `${p.name}共有 ${cities.length} 个地级行政区，包括${cities.slice(0, 6).map((c) => c.name).join('、')}等。在「地图记忆」中通过输入或点击练习，快速记住${short}各地级市在地图上的位置。`;
  written.push(
    write(
      `china/${slug}/index.html`,
      head({
        title,
        description,
        canonical: `/china/${slug}/`,
        keywords: `${short},${p.name},${short}地图,${short}地级市,${short}行政区划,地图记忆`,
      }) +
        `<h1>${esc(p.name)}地图记忆</h1>
<p class="sub">${cities.length} 个地级行政区</p>
<div class="crumbs"><a href="/">${BRAND}</a> › <a href="/china/">中国各省</a> › ${esc(short)}</div>
<div class="card">
<p><strong>${esc(p.name)}</strong>下辖 <strong>${cities.length}</strong> 个地级行政区。要记住它们在地图上的位置，最好的办法是在空白地图上逐个指认——这正是「地图记忆」的做法：地图不显示名称，由你输入或点击作答，答对变绿、答错变红，错误的地方会重复出现直到记牢。</p>
<a class="cta" href="${deepLink(`g=city&p=${p.adcode}`)}">练习${esc(short)}地级市</a>
<a class="cta ghost" href="${deepLink('g=city')}">练习全国地级市</a>
</div>
<h2>${esc(p.name)}地级行政区完整清单</h2>
<ul class="grid">
${list}
</ul>` +
        footer,
    ),
  );
}

// ---------- 世界目录页 ----------
{
  const rows = Object.keys(CONTINENT_SLUG)
    .map((cid) => {
      const meta = subregions.find((s) => s.continent === cid);
      const n = countries.filter((c) => c.continent === cid).length;
      const name = { AS: '亚洲', EU: '欧洲', AF: '非洲', NA: '北美洲', SA: '南美洲', OC: '大洋洲' }[cid];
      return `<li><a href="/world/${CONTINENT_SLUG[cid]}/">${name}</a>（${n} 国${meta ? '' : ''}）</li>`;
    })
    .join('\n');
  const title = `世界国家地图记忆 - 全部 ${countries.length} 个国家与六大洲分区练习 | ${BRAND}`;
  const description = `世界 ${countries.length} 个国家的完整清单与地图记忆练习，按亚洲、欧洲、非洲、北美洲、南美洲、大洋洲分洲，并细分东亚、东南亚、南亚、西亚、中亚等次区域，逐层缩小范围记忆国家位置。`;
  written.push(
    write(
      'world/index.html',
      head({ title, description, canonical: '/world/', keywords: '世界国家,世界地图,世界各国,国家记忆,大洲,地图记忆' }) +
        `<h1>世界国家地图记忆</h1>
<p class="sub">${countries.length} 个国家 · 6 个大洲 · ${subregions.length} 个次区域</p>
<div class="crumbs"><a href="/">${BRAND}</a> › 世界各大洲</div>
<p>「地图记忆」收录 <strong>${countries.length}</strong> 个答题国家（联合国会员国及观察员国），可按大洲逐层下钻，再按次区域细分，把「记住全世界」拆成一个个能完成的小目标。</p>
<a class="cta" href="${deepLink('g=world')}">练习世界各国</a>
<a class="cta ghost" href="${deepLink('g=world&c=AS')}">先练亚洲</a>
<h2>六大洲</h2>
<ul class="grid">
${rows}
</ul>
<h2>怎么用分层下钻记住国家</h2>
<p>一次记 ${countries.length} 个国家很难，但先只记一个大洲就容易得多。选中大洲后地图只显示该洲，其他洲隐藏；若该洲还分了次区域（如亚洲分为东亚、东南亚、南亚、西亚、中亚），可以再下钻一层，把范围缩到十几个国家。点地图空白处即返回上一级。</p>` +
        footer,
    ),
  );
}

// ---------- 大洲页 + 次区域页 ----------
for (const [cid, slug] of Object.entries(CONTINENT_SLUG)) {
  const continentName = { AS: '亚洲', EU: '欧洲', AF: '非洲', NA: '北美洲', SA: '南美洲', OC: '大洋洲' }[cid];
  const inContinent = countries.filter((c) => c.continent === cid);
  const subs = subregions.filter((s) => s.continent === cid);
  const hasSub = subs.length > 1;
  const countryList = inContinent.map((c) => `<li>${esc(c.name)} <span style="opacity:.55">${esc(c.fullName)}</span></li>`).join('\n');
  const title = `${continentName}地图记忆 - ${continentName}${inContinent.length}个国家清单与练习 | ${BRAND}`;
  const description = `${continentName}共有 ${inContinent.length} 个答题国家，包括${inContinent.slice(0, 8).map((c) => c.name).join('、')}等。在「地图记忆」中练习${continentName}国家位置${hasSub ? `，并可细分${subs.map((s) => s.name).join('、')}` : ''}。`;
  written.push(
    write(
      `world/${slug}/index.html`,
      head({ title, description, canonical: `/world/${slug}/`, keywords: `${continentName},${continentName}国家,${continentName}地图,世界地理,地图记忆` }) +
        `<h1>${continentName}地图记忆</h1>
<p class="sub">${inContinent.length} 个国家${hasSub ? ` · ${subs.length} 个次区域` : ''}</p>
<div class="crumbs"><a href="/">${BRAND}</a> › <a href="/world/">世界各大洲</a> › ${continentName}</div>
<div class="card">
<p>${continentName}有 <strong>${inContinent.length}</strong> 个答题国家。${hasSub ? `按地理方位可再分为 ${subs.length} 个次区域：${subs.map((s) => `${s.name}（${s.count} 国）`).join('、')}。先练一个次区域，比一次记全洲容易得多。` : '国家数量不多，可以直接整洲练习。'}</p>
<a class="cta" href="${deepLink(`g=world&c=${cid}`)}">练习${continentName}全部国家</a>
</div>
${
  hasSub
    ? `<h2>${continentName}的次区域</h2>
<ul class="grid">
${subs.map((s) => `<li><a href="/world/${slug}/${SUBREGION_SLUG[s.id]}/">${esc(s.name)}</a>（${s.count} 国）</li>`).join('\n')}
</ul>`
    : ''
}
<h2>${continentName}国家完整清单</h2>
<ul class="grid">
${countryList}
</ul>` +
        footer,
    ),
  );

  // 次区域页（仅该洲确有多个分区时生成；南美只有「南美」一个分区，不生成）
  if (!hasSub) continue;
  for (const s of subs) {
    const inSub = countries.filter((c) => byIso[c.iso] === s.id);
    const stitle = `${s.name}地图记忆 - ${s.name}${inSub.length}个国家清单与练习 | ${BRAND}`;
    const sdesc = `${s.name}共有 ${inSub.length} 个答题国家，包括${inSub.slice(0, 8).map((c) => c.name).join('、')}等。在「地图记忆」中把范围缩到${s.name}，逐个记住这些国家在地图上的位置。`;
    written.push(
      write(
        `world/${slug}/${SUBREGION_SLUG[s.id]}/index.html`,
        head({
          title: stitle,
          description: sdesc,
          canonical: `/world/${slug}/${SUBREGION_SLUG[s.id]}/`,
          keywords: `${s.name},${s.name}国家,${s.name}地图,${continentName},地图记忆`,
        }) +
          `<h1>${s.name}地图记忆</h1>
<p class="sub">${inSub.length} 个国家 · 属${continentName}</p>
<div class="crumbs"><a href="/">${BRAND}</a> › <a href="/world/">世界各大洲</a> › <a href="/world/${slug}/">${continentName}</a> › ${esc(s.name)}</div>
<div class="card">
<p><strong>${esc(s.name)}</strong>包含 <strong>${inSub.length}</strong> 个答题国家。选中${s.name}后，地图只显示这一片区域，范围小、目标明确，适合作为一次完整的记忆任务。</p>
<a class="cta" href="${deepLink(`g=world&c=${cid}&s=${s.id}`)}">练习${esc(s.name)}</a>
<a class="cta ghost" href="${deepLink(`g=world&c=${cid}`)}">练习整个${continentName}</a>
</div>
<h2>${esc(s.name)}国家完整清单</h2>
<ul class="grid">
${inSub.map((c) => `<li>${esc(c.name)} <span style="opacity:.55">${esc(c.fullName)}</span></li>`).join('\n')}
</ul>` +
          footer,
      ),
    );
  }
}

// ---------- 404.html（关闭 Cloudflare Pages SPA fallback 的硬性前提）----------
// 为什么必须存在：Cloudflare Pages 在项目没有顶层 404.html 时按 SPA 处理，
// 把所有未知路径匹配到 `/` 并返回 **HTTP 200** —— 于是 /robots.txt、/sitemap.xml
// 和任何拼错的 URL 都变成「同一页重复内容」，百度无法读取 robots.txt，
// 也会把 soft-404 当作死链（见 docs/adr/0004）。
// 本站**没有任何客户端路由**（全库零 pushState/history/popstate），整个应用只活在 `/`，
// 所以加 404.html 不可能破坏任何深层链接。
{
  const title = `页面不存在（404）| ${BRAND}`;
  written.push(
    write(
      '404.html',
      head({
        title,
        description: '你访问的页面不存在。返回地图记忆首页，开始练习中国行政区与世界国家地图记忆。',
        canonical: '/404.html',
      }) +
        `<h1>页面不存在</h1>
<p class="sub">HTTP 404</p>
<p>你访问的地址没有对应内容。可能是链接已失效或网址有误。</p>
<a class="cta" href="/">返回 ${BRAND} 首页</a>
<a class="cta ghost" href="/china/">中国各省</a>
<a class="cta ghost" href="/world/">世界各大洲</a>` +
        footer,
    ),
  );
}

// ---------- robots.txt ----------
{
  const body = `# ${BRAND} - ${TAGLINE}
# 允许全部主流蜘蛛抓取（含百度、Google、Bing、搜狗、360）
User-agent: *
Allow: /
Disallow: /api/

User-agent: Baiduspider
Allow: /

User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

User-agent: Sogou web spider
Allow: /

User-agent: 360Spider
Allow: /

Sitemap: ${SITE}/sitemap.xml
`;
  written.push(write('robots.txt', body));
}

// ---------- sitemap.xml ----------
// 注意：百度明确拒绝**索引型 sitemap**（「索引型 sitemap 文件不予处理，
// 且若存在索引型 sitemap，将不允许提交新文件」），故必须是扁平的单个 urlset。
{
  const urls = [
    { loc: '/', priority: '1.0', changefreq: 'weekly' },
    { loc: '/china/', priority: '0.9', changefreq: 'monthly' },
    { loc: '/world/', priority: '0.9', changefreq: 'monthly' },
    ...provinces.map((p) => ({ loc: `/china/${PROVINCE_SLUG[p.adcode]}/`, priority: '0.8', changefreq: 'monthly' })),
    ...Object.entries(CONTINENT_SLUG).map(([, slug]) => ({ loc: `/world/${slug}/`, priority: '0.8', changefreq: 'monthly' })),
    ...subregions
      .filter((s) => subregions.filter((x) => x.continent === s.continent).length > 1)
      .map((s) => ({
        loc: `/world/${CONTINENT_SLUG[s.continent]}/${SUBREGION_SLUG[s.id]}/`,
        priority: '0.7',
        changefreq: 'monthly',
      })),
  ];
  // 百度普通收录单次最多 50000 条、文件 < 10MB；此处约 60 条，远低于上限。
  if (urls.length > 50000) fail('sitemap 超过百度 50000 条上限');
  const lastmod = dataLastmod();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${SITE}${u.loc}</loc>
${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`;
  written.push(write('sitemap.xml', body));
}

/**
 * sitemap 的 lastmod = **数据源最后一次提交的日期**（而非构建当天）。
 *
 * 为什么不用 `new Date()`：落地页与 sitemap 是随仓库提交的构建产物，
 * 用构建时间会让每次 CI 构建都产生一份无意义的 diff（`lastmod` 天天变），
 * 而且一个「永远等于今天」的 lastmod 会被爬虫识别为不可信信号并整体忽略
 * ——那还不如不给。取数据源的真实提交日期，语义上正是「这些地名的清单最后一次变化」。
 *
 * git 不可用（无 .git 的构建环境）时返回 null，此时**省略** lastmod 标签：
 * 它是可选字段，缺失是合法的，编一个假日期不是。
 */
function dataLastmod() {
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%cs', '--', 'public/data/units.json', 'public/data/countries.json', 'public/data/subregions.json'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

console.log(`✓ SEO 落地页生成完成：${written.length} 个文件`);
console.log(`  省级页 ${provinces.length} · 大洲页 ${Object.keys(CONTINENT_SLUG).length} · 次区域页 ${subregions.filter((s) => subregions.filter((x) => x.continent === s.continent).length > 1).length}`);
console.log(`  中国省级 ${provinces.length} 个 · 地级 ${unitTotal} 个 · 国家 ${countries.length} 个 · 次区域 ${subregions.length} 个`);
