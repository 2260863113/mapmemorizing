import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CountryMeta, CountryNames } from './types';

/**
 * `world_names.json`（英文名 / 首都名）与 `countries.json`（答题国）的**覆盖一致性**。
 *
 * 为什么这是关键不变式：「国名 / 首都」与「中文 / 英文」两组分段按钮是按 iso 查这张表的，
 * 少一条的表现是**某个国家的首都题永远显示国名**（回落后缀）—— 在地图上点半天才发现，
 * 而且很容易被当成"数据源没有这个国家"而放过去。故这里逐 iso 断言，两侧集合必须完全一致。
 *
 * 与 `tierConsistency.test.ts` / `subregions.test.ts` 同一手法：读构建产物做跨文件一致性断言。
 */
const DATA_DIR = path.join(process.cwd(), 'public', 'data');
const countries = JSON.parse(readFileSync(path.join(DATA_DIR, 'countries.json'), 'utf8')) as { countries: CountryMeta[] };
const raw = JSON.parse(readFileSync(path.join(DATA_DIR, 'world_names.json'), 'utf8')) as { source: string; names: Record<string, CountryNames> };

describe('world_names.json × countries.json', () => {
  it('两者 iso 集合完全一致（不多不少）', () => {
    const fromNames = Object.keys(raw.names).sort();
    const fromCountries = countries.countries.map((c) => c.iso).sort();
    expect(fromNames.filter((iso) => !fromCountries.includes(iso))).toEqual([]);
    expect(fromCountries.filter((iso) => !fromNames.includes(iso))).toEqual([]);
  });

  it('每条都填齐了 en / capital / capitalEn，且不含空白串', () => {
    const bad = Object.entries(raw.names)
      .filter(([, v]) => !v.en?.trim() || !v.capital?.trim() || !v.capitalEn?.trim())
      .map(([iso, v]) => `${iso}=${JSON.stringify(v)}`);
    expect(bad).toEqual([]);
  });

  it('首都名里不留繁体字（数据源的个别译名是繁体，构建期必须转成简体）', () => {
    // 常见的"只出现在繁体里"的字：出现即说明这一条漏转换了
    const traditionalOnly = ['蘭', '維', '爾', '亞', '馬', '華', '區', '國', '島', '灣', '聯', '幣', '蘇'];
    const bad = Object.entries(raw.names)
      .filter(([, v]) => traditionalOnly.some((ch) => v.capital.includes(ch)))
      .map(([iso, v]) => `${iso}:${v.capital}`);
    expect(bad).toEqual([]);
  });

  it('source 写明了数据来源与许可（公有领域可入库）', () => {
    expect(raw.source).toMatch(/natural earth/i);
  });
});
