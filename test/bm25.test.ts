import { describe, it, expect } from 'vitest';
import { rankBM25, tokenize } from '../src/bm25.js';

describe('tokenize', () => {
  it('lowercases and removes stop words', () => {
    const tokens = tokenize('The quick brown Fox jumps over the lazy Dog');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
    expect(tokens).toContain('fox');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('over');
  });

  it('splits on punctuation and special chars', () => {
    const tokens = tokenize('src/auth/login.ts:42');
    expect(tokens).toContain('src');
    expect(tokens).toContain('auth');
    expect(tokens).toContain('login');
  });
});

describe('rankBM25', () => {
  const docs = [
    'The weather today is sunny and warm',
    'Authentication requires a valid login token',
    'The database stores user credentials securely',
    'React hooks like useState manage component state',
    'Login security depends on token validation',
  ];

  it('ranks relevant documents higher', () => {
    const results = rankBM25(docs, (d) => d, 'login authentication token');
    // Docs about login/auth should rank highest
    expect(results[0].item.toLowerCase()).toContain('login');
    expect(results[1].item.toLowerCase()).toContain('login');
  });

  it('returns all items even with no matches', () => {
    const results = rankBM25(docs, (d) => d, 'quantum physics');
    expect(results).toHaveLength(5);
    // All scores should be 0
    expect(results.every((r) => r.score === 0)).toBe(true);
  });

  it('handles empty query', () => {
    const results = rankBM25(docs, (d) => d, '');
    expect(results).toHaveLength(5);
  });

  it('handles empty items', () => {
    const results = rankBM25([], (d) => d, 'test');
    expect(results).toHaveLength(0);
  });

  it('preserves original index', () => {
    const results = rankBM25(docs, (d) => d, 'login');
    // Original indices should be preserved
    const loginIdx = docs.findIndex((d) => d.includes('valid login'));
    const found = results.find((r) => r.item.includes('valid login'));
    expect(found?.index).toBe(loginIdx);
  });
});
