import { describe, it, expect } from 'vitest';
import { compressTruncate } from '../src/compressors/truncate.js';

describe('compressTruncate', () => {
  it('passes through short text (below 5k tokens)', async () => {
    const block = { type: 'text', text: 'short text' };
    const result = await compressTruncate(block, 2000);
    expect(result.text).toBe('short text');
  });

  it('passes through text under 5k token threshold', async () => {
    // 16000 chars = ~4000 tokens — below PASSTHROUGH_THRESHOLD (5000)
    const text = 'A'.repeat(16000);
    const result = await compressTruncate({ type: 'text', text }, 2000);
    expect(result.text).toBe(text);
  });

  it('compresses text over 5k tokens with head/middle/tail', async () => {
    // ~120k chars = ~30k tokens — middle will be ~27k, above GEMINI_THRESHOLD (20k)
    const bigText = Array.from({ length: 1000 }, (_, i) =>
      `Line ${i}: ${'content '.repeat(25)}`
    ).join('\n');
    const result = await compressTruncate({ type: 'text', text: bigText }, 2000);
    expect(result.text).toContain('[... compressed middle:');
    expect(result.text!.length).toBeLessThan(bigText.length);
  });

  it('preserves head and tail of large text', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) =>
      `Line ${i}: ${'data '.repeat(25)}`
    ).join('\n');
    const result = await compressTruncate({ type: 'text', text: lines }, 2000);
    // Head should contain early lines
    expect(result.text).toContain('Line 0:');
    expect(result.text).toContain('Line 1:');
    // Tail should contain late lines
    expect(result.text).toContain('Line 999:');
    expect(result.text).toContain('Line 998:');
  });

  it('uses BM25 ranking when tool context is provided', async () => {
    // Create text with a specific keyword buried in the middle
    // Need enough total tokens (>5k) and middle >20k for compression to kick in
    const lines = Array.from({ length: 1000 }, (_, i) => {
      if (i >= 400 && i <= 420) {
        return `Line ${i}: authentication login security token validation credentials`;
      }
      return `Line ${i}: ${'generic filler content about weather and climate patterns '.repeat(3)}`;
    }).join('\n');

    const toolContext = {
      toolName: 'read_file',
      toolArgs: { path: 'src/auth/login.ts' },
    };

    const result = await compressTruncate({ type: 'text', text: lines }, 2000, toolContext);
    // BM25 should rank auth-related lines higher
    expect(result.text).toContain('authentication');
    expect(result.text).toContain('login');
  });

  it('passes through non-text blocks', async () => {
    const block = { type: 'image', data: 'abc' };
    const result = await compressTruncate(block, 2000);
    expect(result).toBe(block);
  });
});
