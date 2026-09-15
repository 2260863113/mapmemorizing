import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { CountryMeta } from './types';

/**
 * 国旗资源（`public/data/flags/`）与答题国的**覆盖一致性**。
 *
 * 为什么关键：点击模式的「国旗」档是拿 iso 去查 `index.json` 再拼成 `data/flags/<文件>` 的。
 * 少一条的表现是**某国的国旗题会被回落成国名题**（或更糟：一张破图/空白卡片）——
 * 而这类问题只在随机抽到那个国家时才暴露。所以这里逐条断言：
 *   · 键集合与 `countries.json` 完全一致；
 *   · 每个被引用的文件**真的存在**、非空、确实是一份 SVG（不是 404 页面或占位文本）；
 *   · 目录里没有"孤儿"文件（存在但不被任何键引用 —— 通常意味着改名后忘了重新生成）。
 *
 * 与 `tierConsistency.test.ts` / `worldNamesData.test.ts` 同一手法：读构建产物做跨文件断言。
 */
const FLAG_DIR = path.join(process.cwd(), 'public', 'data', 'flags');
const countries = JSON.parse(readFileSync(path.join(process.cwd(), 'public', 'data', 'countries.json'), 'utf8')) as {
  countries: CountryMeta[];
};
const index = JSON.parse(readFileSync(path.join(FLAG_DIR, 'index.json'), 'utf8')) as {
  source: string;
  flags: Record<string, string>;
};

describe('国旗资源 × countries.json', () => {
  it('键集合完全一致（不多不少）', () => {
    const keys = Object.keys(index.flags).sort();
    const isos = countries.countries.map((c) => c.iso).sort();
    expect(keys.filter((iso) => !isos.includes(iso))).toEqual([]);
    expect(isos.filter((iso) => !keys.includes(iso))).toEqual([]);
  });

  it('每条引用的文件都存在、非空、且是 SVG', () => {
    const bad: string[] = [];
    for (const [iso, file] of Object.entries(index.flags)) {
      expect(file.trim(), `${iso} 的文件名为空`).not.toBe('');
      let text = '';
      try {
        text = readFileSync(path.join(FLAG_DIR, file), 'utf8');
      } catch {
        bad.push(`${iso}: 文件缺失 ${file}`);
        continue;
      }
      const head = text.trimStart().slice(0, 200).toLowerCase();
      if (!head.includes('<svg')) bad.push(`${iso}: ${file} 不是 SVG（开头是 ${JSON.stringify(head.slice(0, 40))}）`);
    }
    expect(bad).toEqual([]);
  });

  it('目录里没有被引用的孤儿文件', () => {
    const referenced = new Set(Object.values(index.flags));
    const orphans = readdirSync(FLAG_DIR)
      .filter((f) => f.endsWith('.svg'))
      .filter((f) => !referenced.has(f));
    expect(orphans).toEqual([]);
  });

  it('source 写明了数据来源与许可（可入库的开放许可）', () => {
    expect(index.source.length).toBeGreaterThan(10);
    expect(index.source.toLowerCase()).toMatch(/mit|public domain|cc0|公有领域/);
  });
});
