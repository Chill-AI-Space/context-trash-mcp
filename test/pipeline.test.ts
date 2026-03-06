import { describe, it, expect } from 'vitest';
import { compressResult } from '../src/pipeline.js';
import { Config } from '../src/config.js';

const baseConfig: Config = {
  imageOcr: true,
  jsonCollapse: true,
  textCompressionThreshold: 100_000,
  compressionPrompt: 'Shorten. Target: {TARGET} tokens.',
  ocrEngine: 'auto',
  verbose: false,
  dryRun: false,
  rules: [
    { toolName: 'browser_snapshot', strategy: 'dom-cleanup' },
    { toolNamePattern: '.*', strategy: 'auto' },
  ],
};

/** Get all text from content blocks joined */
function allText(result: { content?: Array<{ type: string; text?: string; data?: string }> }): string {
  return (result.content ?? []).map((b) => b.text ?? '').join('\n');
}

describe('compressResult', () => {
  it('passes through small text results (no compression needed)', async () => {
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

  it('passes through medium text (below 100k threshold)', async () => {
    // ~30k tokens — well below 100k threshold
    const mediumText = Array.from({ length: 1000 }, (_, i) =>
      `Line ${i}: ${'content '.repeat(25)}`
    ).join('\n');
    const result = { content: [{ type: 'text', text: mediumText }] };
    const compressed = await compressResult('unknown_tool', result, baseConfig);
    // Should NOT compress — text is below threshold
    expect(compressed).toBe(result);
  });

  it('passes through images when no file path in result', async () => {
    const fakeBase64 = 'A'.repeat(5000);
    const result = { content: [{ type: 'image', data: fakeBase64, mimeType: 'image/png' }] };
    const compressed = await compressResult('generate_image', result, baseConfig);
    const images = (compressed.content ?? []).filter((b) => b.type === 'image');
    expect(images[0].data).toBe(fakeBase64);
  });

  it('applies json-collapse for large JSON arrays', async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      id: i, name: `item-${i}`, email: `user${i}@example.com`,
      bio: `This is the biography for user number ${i} with some extra text`,
    }));
    const bigJson = JSON.stringify(items);
    const result = { content: [{ type: 'text', text: bigJson }] };
    const compressed = await compressResult('db_query', result, baseConfig);
    const text = allText(compressed);
    expect(text).toContain('[compress-on-input:');
    expect(text).toContain('[JSON collapsed');
    expect(text).toContain('item-0');
    expect(text).toContain('more items');
  });

  it('respects jsonCollapse=false', async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      id: i, name: `item-${i}`,
    }));
    const bigJson = JSON.stringify(items);
    const result = { content: [{ type: 'text', text: bigJson }] };
    const noJsonConfig = { ...baseConfig, jsonCollapse: false };
    const compressed = await compressResult('db_query', result, noJsonConfig);
    // Should pass through — JSON collapse disabled
    expect(compressed).toBe(result);
  });

  it('dry-run does not modify result', async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      id: i, name: `item-${i}`, email: `user${i}@example.com`,
    }));
    const bigJson = JSON.stringify(items);
    const result = { content: [{ type: 'text', text: bigJson }] };
    const dryConfig = { ...baseConfig, dryRun: true };
    const compressed = await compressResult('unknown_tool', result, dryConfig);
    expect(compressed.content![0].text).toBe(bigJson);
  });

  it('summary includes compression stats', async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      id: i, name: `item-${i}`, email: `user${i}@example.com`,
      bio: `This is the biography for user number ${i}`,
    }));
    const bigJson = JSON.stringify(items);
    const result = { content: [{ type: 'text', text: bigJson }] };
    const compressed = await compressResult('db_query', result, baseConfig);
    const summary = compressed.content![0].text!;
    expect(summary).toContain('[compress-on-input:');
    expect(summary).toContain('tokens');
  });
});
