import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeAttr } from './html';

describe('escapeHtml', () => {
  it('escapes HTML-significant chars', () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });
});

describe('escapeAttr', () => {
  it('escapes both quote styles to prevent attribute breakout', () => {
    expect(escapeAttr(`' onerror='alert(1)`)).toBe('&#39; onerror=&#39;alert(1)');
    expect(escapeAttr(`"`)).toBe('&quot;');
    expect(escapeAttr(`a&b<c>`)).toBe('a&amp;b&lt;c&gt;');
  });

  it('is safe inside single-quoted attribute (avatar url)', () => {
    const url = `x'); onerror='alert(1`;
    const html = `<span style="background-image:url('${escapeAttr(url)}')"></span>`;
    expect(html).not.toContain(`'); onerror=`);
  });
});
