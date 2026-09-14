import { describe, it, expect, afterEach, vi } from 'vitest';
import { compressAvatar, MAX_AVATAR_SIZE } from './avatarImage';
import { MAX_AVATAR_SIZE as BACKEND_MAX_AVATAR_SIZE } from '../../functions/_lib/limits';

/**
 * 头像压缩的定点单测 + 前后端上限一致性断言。
 *
 * 为什么需要一致性断言：后端按 `MAX_AVATAR_SIZE` 拒收（`functions/_lib/profile.ts`），
 * 前端按同一个数字压。两侧一旦漂移，用户就会遇到「选图成功、保存被拒」这类只在上线后才暴露的缺陷。
 * 与 `subregions.test.ts` 断言前后端哨兵同一手法。
 */

const JPEG_PREFIX = 'data:image/jpeg;base64,'; // 与实现同长度（23）
const PREFIX_LEN = JPEG_PREFIX.length;

/** 记录最近一次建的 canvas（尺寸断言用）。 */
let lastCanvas: { width: number; height: number } | null = null;

/** 造一个「原图 + 假 canvas」环境。qualityBytes 决定每个质量档产出多少字节。 */
function stubBrowser(opts: {
  width: number;
  height: number;
  qualityBytes?: (q: number) => number;
  failImage?: boolean;
  noCtx?: boolean;
}) {
  const qualityBytes = opts.qualityBytes ?? ((q: number) => Math.round(q * 1000));
  lastCanvas = null;
  class FakeImage {
    naturalWidth = opts.width;
    naturalHeight = opts.height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => (opts.failImage ? this.onerror?.() : this.onload?.()));
    }
  }
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} });
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => (opts.noCtx ? null : { fillStyle: '', fillRect: () => {}, drawImage: () => {} }),
        toDataURL: (_type: string, quality?: number) => JPEG_PREFIX + 'A'.repeat(qualityBytes(quality ?? 1)),
      };
      lastCanvas = canvas;
      return canvas;
    },
  });
}

// 只被用来取 objectURL，故不必依赖 Node 的 File 全局实现
const file = { name: 'a.png' } as unknown as File;

afterEach(() => vi.unstubAllGlobals());

describe('MAX_AVATAR_SIZE', () => {
  it('与后端 limits 的同一常量严格相等（否则前端压得过、后端仍拒收）', () => {
    expect(MAX_AVATAR_SIZE).toBe(BACKEND_MAX_AVATAR_SIZE);
  });
});

describe('compressAvatar', () => {
  it('等比缩到最长边 128px（512×256 → 128×64）', async () => {
    stubBrowser({ width: 512, height: 256 });
    const out = await compressAvatar(file);
    expect(lastCanvas).toMatchObject({ width: 128, height: 64 });
    expect(out.type).toBe('image/jpeg');
  });

  it('不放大：短边图保持原尺寸（64×64 → 64×64）', async () => {
    stubBrowser({ width: 64, height: 64 });
    await compressAvatar(file);
    expect(lastCanvas).toMatchObject({ width: 64, height: 64 });
  });

  it('按质量阶梯取首个达标档：上限 1000B 时第一档（0.85 → 850B×3/4）即通过', async () => {
    stubBrowser({ width: 200, height: 200 });
    const out = await compressAvatar(file, 1000);
    expect(out.size).toBe(Math.round(850 * 0.75));
    expect(out.size).toBeLessThanOrEqual(1000);
  });

  it('字节数按 base64 长度 × 3/4 反算（后端按 size 字段校验）', async () => {
    stubBrowser({ width: 200, height: 200 });
    const out = await compressAvatar(file, 10_000);
    expect(out.size).toBe(Math.round(((out.dataUrl.length - PREFIX_LEN) * 3) / 4));
    expect(out.size).toBeLessThanOrEqual(MAX_AVATAR_SIZE);
  });

  it('压到底仍超上限时抛错（而不是提交一张必然被后端拒收的头像）', async () => {
    stubBrowser({ width: 200, height: 200, qualityBytes: () => 100_000 });
    await expect(compressAvatar(file, 1024)).rejects.toThrow();
  });

  it('取不到 2d 上下文时抛错，不静默产出空图', async () => {
    stubBrowser({ width: 100, height: 100, noCtx: true });
    await expect(compressAvatar(file)).rejects.toThrow();
  });

  it('图片读不出来时抛错（并释放 objectURL）', async () => {
    const revoke = vi.fn();
    stubBrowser({ width: 100, height: 100, failImage: true });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: revoke });
    await expect(compressAvatar(file)).rejects.toThrow();
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });
});
