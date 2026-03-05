import { describe, it, expect } from 'vitest';
import { compressResult } from '../src/pipeline.js';
import { Config } from '../src/config.js';

const baseConfig: Config = {
  threshold: 500,
  maxTextTokens: 2000,
  ocrEngine: 'auto',
  verbose: false,
  dryRun: false,
  activationBytes: 400_000,
  rules: [
    { toolName: 'browser_snapshot', strategy: 'dom-cleanup' },
    { toolNamePattern: '.*', strategy: 'auto' },
  ],
};

describe('compressResult', () => {
  it('passes through small results below threshold', async () => {
    const result = { content: [{ type: 'text', text: 'small' }] };
    const compressed = await compressResult('some_tool', result, baseConfig);
    expect(compressed.content![0].text).toBe('small');
  });

  it('passes through empty results', async () => {
    const result = { content: [] };
    const compressed = await compressResult('some_tool', result, baseConfig);
    expect(compressed.content).toEqual([]);
  });

  it('passes through results without content', async () => {
    const result = { something: 'else' };
    const compressed = await compressResult('some_tool', result, baseConfig);
    expect(compressed).toEqual(result);
  });

  it('applies dom-cleanup to browser_snapshot', async () => {
    const bigDom = Array.from({ length: 100 }, (_, i) =>
      `- button "Item ${i}" [ref=${i}]`
    ).join('\n');
    const result = { content: [{ type: 'text', text: bigDom }] };
    const compressed = await compressResult('browser_snapshot', result, baseConfig);
    // Refs should be stripped from inline but present in mapping table
    expect(compressed.content![0].text).not.toMatch(/\[ref=\d+\]/);
    expect(compressed.content![0].text).toContain('[Element references]');
  });

  it('applies smart truncation via auto for large text', async () => {
    // ~120k chars = ~30k tokens — middle will be above GEMINI_THRESHOLD
    const bigText = Array.from({ length: 1000 }, (_, i) =>
      `Line ${i}: ${'content '.repeat(25)}`
    ).join('\n');
    const result = { content: [{ type: 'text', text: bigText }] };
    const compressed = await compressResult('unknown_tool', result, baseConfig);
    expect(compressed.content![0].text).toContain('[... compressed middle:');
  });

  it('passes through images when no file path in result (base64 is only copy)', async () => {
    const fakeBase64 = 'A'.repeat(5000);
    const result = { content: [{ type: 'image', data: fakeBase64, mimeType: 'image/png' }] };
    const compressed = await compressResult('generate_image', result, baseConfig);
    expect(compressed.content![0].type).toBe('image');
    expect(compressed.content![0].data).toBe(fakeBase64);
  });

  it('applies json-collapse via auto for large JSON arrays', async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      id: i, name: `item-${i}`, email: `user${i}@example.com`,
      bio: `This is the biography for user number ${i} with some extra text`,
    }));
    const bigJson = JSON.stringify(items);
    const result = { content: [{ type: 'text', text: bigJson }] };
    const compressed = await compressResult('db_query', result, baseConfig);
    expect(compressed.content![0].text).toContain('[JSON collapsed');
    expect(compressed.content![0].text).toContain('item-0');
    expect(compressed.content![0].text).toContain('more items');
  });

  it('dry-run does not modify result', async () => {
    const bigText = Array.from({ length: 1000 }, (_, i) =>
      `Line ${i}: ${'content '.repeat(25)}`
    ).join('\n');
    const result = { content: [{ type: 'text', text: bigText }] };
    const dryConfig = { ...baseConfig, dryRun: true };
    const compressed = await compressResult('unknown_tool', result, dryConfig);
    expect(compressed.content![0].text).toBe(bigText);
  });
});
