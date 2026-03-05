import { describe, it, expect } from 'vitest';
import { chunkText } from '../src/chunker.js';

describe('chunkText', () => {
  it('returns single chunk for small text', () => {
    const chunks = chunkText('Hello world', 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Hello world');
    expect(chunks[0].index).toBe(0);
  });

  it('splits large text into multiple chunks', () => {
    const text = Array.from({ length: 100 }, (_, i) =>
      `Paragraph ${i}: ${'word '.repeat(50)}`
    ).join('\n\n');
    const chunks = chunkText(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should have reasonable token counts
    for (const chunk of chunks) {
      expect(chunk.tokens).toBeGreaterThan(0);
    }
  });

  it('preserves chunk ordering via index', () => {
    const text = Array.from({ length: 50 }, (_, i) =>
      `Section ${i}: ${'content '.repeat(40)}`
    ).join('\n\n');
    const chunks = chunkText(text, 200);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  it('splits by paragraph boundaries first', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkText(text, 5); // very small target to force splitting
    // Should have split at paragraph boundaries
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('handles text with no natural boundaries', () => {
    const text = 'A'.repeat(10000); // no spaces or newlines
    const chunks = chunkText(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
