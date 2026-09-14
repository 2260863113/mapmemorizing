/**
 * 头像图片压缩：把用户选的原图压到指定字节数以内，产出可直接持久化的 dataUrl。
 *
 * 为什么单独成模块：这段逻辑原先内联在 `authPanel.ts` 尾部（两个自由函数 + 一条压缩阶梯），
 * 但它**不碰面板状态**，只依赖 canvas / File —— 是「图片 → 合规头像」的纯变换，
 * 抽出来后可脱离浏览器单测（见 `avatarImage.test.ts`），也让面板类只剩视图与接线。
 *
 * 上限口径与后端一致：`functions/_lib/limits.ts` 的 `MAX_AVATAR_SIZE` 是同一个 20KB；
 * 两侧必须相等，由 `avatarImage.test.ts` 断言（与 `subregions.test.ts` 断言前后端哨兵同一手法）。
 */
import { t } from '../i18n';

/** 压缩目标：原始字节数上限（与 `functions/_lib/limits.ts` 的 MAX_AVATAR_SIZE 必须相等）。 */
export const MAX_AVATAR_SIZE = 20 * 1024;

/** 压缩结果：`size` 是解码后的**原始字节数**（base64 长度 × 3/4），后端按它校验。 */
export interface CompressedAvatar {
  dataUrl: string;
  size: number;
  type: string;
}

/** 压缩阶梯：从高到低逐档试，首档达标即返回（低质量档只用于极端照片）。 */
const QUALITY_STEPS = [0.85, 0.72, 0.6, 0.5, 0.4, 0.3, 0.22, 0.15, 0.1, 0.08];
const JPEG_PREFIX = 'data:image/jpeg;base64,';
const MAX_EDGE = 128;

/**
 * 头像压缩：canvas 缩放（最长边 128px）→ 透明补白 → JPEG 质量逐档降到 ≤maxBytes。
 * 压到底仍超则抛错（错误文案已本地化，调用方直接展示）。
 */
export async function compressAvatar(file: File, maxBytes = MAX_AVATAR_SIZE): Promise<CompressedAvatar> {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('auth.error.avatarCompressFail'));
  // 透明背景补白（PNG/GIF 转 JPEG 时避免黑底）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  for (const quality of QUALITY_STEPS) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const size = Math.round(((dataUrl.length - JPEG_PREFIX.length) * 3) / 4);
    if (size <= maxBytes) return { dataUrl, size, type: 'image/jpeg' };
  }
  throw new Error(t('auth.toast.avatarTooLarge'));
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t('auth.error.avatarReadFail')));
    };
    img.src = url;
  });
}
