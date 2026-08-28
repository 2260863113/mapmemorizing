/** 用于测试摘要的分钟:秒格式。 */
export function formatElapsedSeconds(elapsedMs: number): string {
  const secs = Math.round(elapsedMs / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 用于排行榜的分钟:秒.百分秒格式。 */
export function formatElapsedCentiseconds(elapsedMs: number): string {
  const centis = Math.round(elapsedMs / 10);
  const mm = String(Math.floor(centis / 6000)).padStart(2, '0');
  const ss = String(Math.floor((centis % 6000) / 100)).padStart(2, '0');
  const cc = String(centis % 100).padStart(2, '0');
  return `${mm}:${ss}.${cc}`;
}
