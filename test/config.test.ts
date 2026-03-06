import { describe, it, expect } from 'vitest';
import { loadConfig, findRule } from '../src/config.js';

describe('loadConfig', () => {
  it('returns default config when no file exists', () => {
    const config = loadConfig('/nonexistent/path.json');
    expect(config.imageOcr).toBe(true);
    expect(config.jsonCollapse).toBe(true);
    expect(config.textCompressionThreshold).toBe(100_000);
    expect(config.ocrEngine).toBe('auto');
    expect(config.rules.length).toBeGreaterThan(0);
    expect(config.compressionPrompt).toContain('{TARGET}');
  });
});

describe('findRule', () => {
  const config = loadConfig();

  it('matches exact tool name', () => {
    const rule = findRule(config, 'browser_snapshot');
    expect(rule?.strategy).toBe('dom-cleanup');
  });

  it('matches pattern for unknown tools', () => {
    const rule = findRule(config, 'some_random_tool');
    expect(rule?.strategy).toBe('auto');
  });

  it('prefers exact match over pattern', () => {
    const rule = findRule(config, 'browser_snapshot');
    expect(rule?.strategy).toBe('dom-cleanup');
  });
});
