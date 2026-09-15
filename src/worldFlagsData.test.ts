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
const thumbs = JSON.parse(readFileSync(path.join(FLAG_DIR, 'thumbs.json'), 'utf8')) as {
  source: string;
  thumbs: Record<string, string>;
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

/**
 * 国旗**缩略图**（`public/data/flags/thumbs/`，40×30 WebP）与矢量表的**配对一致性**。
 *
 * 两张表由两个脚本各自生成（`fetch-world-flags.mjs` 下载矢量、`build-flag-thumbs.mjs` 栅格化），
 * 风险正是"其中一个漏跑了、或者只加了新国家的一半"：表现是**地图浏览标签上某个国家的国旗是空白**
 * （破图不报错，只是不显示），比题面缺失更难察觉。故这里逐条断言：
 *   · 键集合与矢量表**逐字相同**（不是各自与 countries.json 比——那会漏掉"两表互相错位"）；
 *   · 每个文件都存在、非空、且真的是 WebP（RIFF....WEBP 头，不是被 404 页面顶替）；
 *   · 尺寸是预期的 4:3 小图（读 WebP 头里的 VP8X/VP8 宽高，防止哪天有人把原图直接拷进来）。
 */
describe('国旗缩略图 × 矢量表', () => {
  it('键集合与 flags/index.json 逐字相同', () => {
    expect(Object.keys(thumbs.thumbs).sort()).toEqual(Object.keys(index.flags).sort());
  });

  it('每条引用的文件都存在、非空、且真的是 WebP', () => {
    const bad: string[] = [];
    for (const [iso, file] of Object.entries(thumbs.thumbs)) {
      let buf: Buffer;
      try {
        buf = readFileSync(path.join(FLAG_DIR, 'thumbs', file));
      } catch {
        bad.push(`${iso}: 文件缺失 ${file}`);
        continue;
      }
      if (buf.length < 100) bad.push(`${iso}: ${file} 只有 ${buf.length} 字节`);
      else if (buf.subarray(0, 4).toString('ascii') !== 'RIFF' || buf.subarray(8, 12).toString('ascii') !== 'WEBP') {
        bad.push(`${iso}: ${file} 不是 WebP（头是 ${JSON.stringify(buf.subarray(0, 12).toString('latin1'))}）`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('是 40×30 的小图（不是误把原图拷进来的大图）', () => {
    // 有损 WebP 的 VP8 帧头：'VP8 ' 后第 6 字节起是 14 位宽高（& 0x3fff）
    const bad: string[] = [];
    for (const [iso, file] of Object.entries(thumbs.thumbs)) {
      const buf = readFileSync(path.join(FLAG_DIR, 'thumbs', file));
      const tag = buf.subarray(12, 16).toString('ascii');
      let w = 0;
      let h = 0;
      if (tag === 'VP8 ') {
        w = buf.readUInt16LE(26) & 0x3fff;
        h = buf.readUInt16LE(28) & 0x3fff;
      } else if (tag === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        w = (bits & 0x3fff) + 1;
        h = ((bits >> 14) & 0x3fff) + 1;
      } else if (tag === 'VP8X') {
        w = buf.readUIntLE(24, 3) + 1;
        h = buf.readUIntLE(27, 3) + 1;
      } else {
        bad.push(`${iso}: ${file} 的 WebP 块类型未知（${JSON.stringify(tag)}）`);
        continue;
      }
      if (w !== 40 || h !== 30) bad.push(`${iso}: ${file} 是 ${w}×${h}，期望 40×30`);
    }
    expect(bad).toEqual([]);
  });

  it('合计体积远小于矢量表（缩略图的意义所在）', () => {
    const total = Object.values(thumbs.thumbs).reduce(
      (s, f) => s + readFileSync(path.join(FLAG_DIR, 'thumbs', f)).length,
      0,
    );
    expect(total).toBeLessThan(400 * 1024); // 实测 163KB；给换源/加国留出余量
  });
});
