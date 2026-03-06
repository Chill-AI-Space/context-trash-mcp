import { describe, it, expect } from 'vitest';
import { classifyContent, estimateTokens } from '../src/classifier.js';

describe('estimateTokens', () => {
  it('estimates ASCII text at ~bytes/4', () => {
    const text = 'Hello world'; // 11 bytes
    expect(estimateTokens(text)).toBe(3); // ceil(11/4)
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('classifyContent', () => {
  it('classifies image blocks', () => {
    expect(classifyContent({ type: 'image', data: 'abc', mimeType: 'image/png' }, 100_000))
      .toBe('image');
  });

  it('classifies DOM snapshots by [ref=', () => {
    expect(classifyContent({ type: 'text', text: '- button "OK" [ref=42]' }, 100_000))
      .toBe('dom-snapshot');
  });

  it('classifies DOM snapshots by role:', () => {
    expect(classifyContent({ type: 'text', text: '- role: navigation' }, 100_000))
      .toBe('dom-snapshot');
  });

  it('classifies large JSON above internal threshold', () => {
    const bigJson = '[' + 'x'.repeat(3000) + ']'; // ~750 tokens, above JSON internal 500
    expect(classifyContent({ type: 'text', text: bigJson }, 100_000))
      .toBe('large-json');
  });

  it('classifies very large text above text threshold', () => {
    const hugeText = 'x'.repeat(500_000); // ~125k tokens > 100k
    expect(classifyContent({ type: 'text', text: hugeText }, 100_000))
      .toBe('large-text');
  });

  it('classifies normal text as small-text', () => {
    expect(classifyContent({ type: 'text', text: 'small' }, 100_000))
      .toBe('small-text');
  });

  it('classifies medium text as small-text (below 100k threshold)', () => {
    const mediumText = 'x'.repeat(40_000); // ~10k tokens, below 100k
    expect(classifyContent({ type: 'text', text: mediumText }, 100_000))
      .toBe('small-text');
  });
});
