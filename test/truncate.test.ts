import { describe, it, expect } from 'vitest';
import { compressTruncate } from '../src/compressors/truncate.js';

const defaultPrompt = 'Shorten this. Target: approximately {TARGET} tokens.';

describe('compressTruncate', () => {
  it('passes through short text', async () => {
    const block = { type: 'text', text: 'short text' };
    const result = await compressTruncate(block, defaultPrompt);
    expect(result.text).toBe('short text');
  });

  it('passes through non-text blocks', async () => {
    const block = { type: 'image', data: 'abc' };
    const result = await compressTruncate(block, defaultPrompt);
    expect(result).toBe(block);
  });

  it('compresses very large text with head/middle/tail', async () => {
    // ~500k chars = ~125k tokens — above default 100k threshold
    const bigText = Array.from({ length: 4000 }, (_, i) =>
      `Line ${i}: ${'content '.repeat(25)}`
    ).join('\n');
    const result = await compressTruncate({ type: 'text', text: bigText }, defaultPrompt);
    expect(result.text).toContain('[... middle compressed');
    expect(result.text!.length).toBeLessThan(bigText.length);
  });

  it('preserves generous head and tail', async () => {
    const lines = Array.from({ length: 4000 }, (_, i) =>
      `Line ${i}: ${'data '.repeat(25)}`
    ).join('\n');
    const result = await compressTruncate({ type: 'text', text: lines }, defaultPrompt);
    // Head should preserve first ~10k tokens worth of lines
    expect(result.text).toContain('Line 0:');
    expect(result.text).toContain('Line 100:');
    // Tail should preserve last ~5k tokens worth
    expect(result.text).toContain('Line 3999:');
    expect(result.text).toContain('Line 3900:');
  });

  it('uses BM25 ranking with tool context', async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => {
      if (i >= 2000 && i <= 2050) {
        return `Line ${i}: authentication login security token validation credentials`;
      }
      return `Line ${i}: ${'generic filler content about weather and climate patterns '.repeat(3)}`;
    }).join('\n');

    const toolContext = {
      toolName: 'read_file',
      toolArgs: { path: 'src/auth/login.ts' },
    };

    const result = await compressTruncate({ type: 'text', text: lines }, defaultPrompt, toolContext);
    expect(result.text).toContain('authentication');
    expect(result.text).toContain('login');
  });
});
