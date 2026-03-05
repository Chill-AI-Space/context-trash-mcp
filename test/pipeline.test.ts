import { describe, it, expect } from 'vitest';
import { compressResult } from '../src/pipeline.js';
import { Config } from '../src/config.js';

const baseConfig: Config = {
  threshold: 500,
  maxTextTokens: 2000,
  ocrEngine: 'auto',
  verbose: false,
  dryRun: false,
  rules: [
    { toolName: 'browser_take_screenshot', strategy: 'ocr' },
    { toolName: 'browser_snapshot', strategy: 'dom-cleanup' },
    { toolNamePattern: '.*', strategy: 'auto' },
  ],
};

describe('compressResult', () => {
  it('passes through small results below threshold', () => {
    const result = { content: [{ type: 'text', text: 'small' }] };
    const compressed = compressResult('some_tool', result, baseConfig);
    expect(compressed.content![0].text).toBe('small');
  });

  it('passes through empty results', () => {
    const result = { content: [] };
    const compressed = compressResult('some_tool', result, baseConfig);
    expect(compressed.content).toEqual([]);
  });

  it('passes through results without content', () => {
    const result = { something: 'else' };
    const compressed = compressResult('some_tool', result, baseConfig);
    expect(compressed).toEqual(result);
  });

  it('applies dom-cleanup to browser_snapshot', () => {
    const bigDom = Array.from({ length: 100 }, (_, i) =>
      `- button "Item ${i}" [ref=${i}]`
    ).join('\n');
    const result = { content: [{ type: 'text', text: bigDom }] };
    const compressed = compressResult('browser_snapshot', result, baseConfig);
    // Refs should be stripped from inline but present in mapping table
    expect(compressed.content![0].text).not.toMatch(/\[ref=\d+\]/);
    expect(compressed.content![0].text).toContain('[Element references]');
  });

  it('applies truncation via auto for large text', () => {
    const bigText = 'x'.repeat(20000);
    const result = { content: [{ type: 'text', text: bigText }] };
    const compressed = compressResult('unknown_tool', result, baseConfig);
    expect(compressed.content![0].text).toContain('[... truncated');
  });

  it('passes through images for unknown tools (safe for image generation MCP)', () => {
    const fakeBase64 = 'A'.repeat(5000); // big enough to pass threshold
    const result = { content: [{ type: 'image', data: fakeBase64, mimeType: 'image/png' }] };
    const compressed = compressResult('generate_image', result, baseConfig);
    // auto strategy should NOT OCR unknown image tools — passthrough
    expect(compressed.content![0].type).toBe('image');
    expect(compressed.content![0].data).toBe(fakeBase64);
  });

  it('dry-run does not modify result', () => {
    const bigText = 'x'.repeat(20000);
    const result = { content: [{ type: 'text', text: bigText }] };
    const dryConfig = { ...baseConfig, dryRun: true };
    const compressed = compressResult('unknown_tool', result, dryConfig);
    expect(compressed.content![0].text).toBe(bigText);
  });
});
