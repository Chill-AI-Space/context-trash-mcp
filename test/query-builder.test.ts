import { describe, it, expect } from 'vitest';
import { buildQuery } from '../src/query-builder.js';

describe('buildQuery', () => {
  it('includes cleaned tool name', () => {
    const query = buildQuery({ toolName: 'browser_navigate' });
    expect(query).toContain('browser navigate');
  });

  it('extracts keywords from URL args', () => {
    const query = buildQuery({
      toolName: 'browser_navigate',
      toolArgs: { url: 'https://docs.python.org/3/library/asyncio.html' },
    });
    expect(query).toContain('asyncio');
    expect(query).toContain('library');
    expect(query).toContain('docs.python.org');
  });

  it('extracts keywords from file path args', () => {
    const query = buildQuery({
      toolName: 'read_file',
      toolArgs: { path: 'src/auth/login.ts' },
    });
    expect(query).toContain('auth');
    expect(query).toContain('login');
  });

  it('includes search patterns and commands', () => {
    const query = buildQuery({
      toolName: 'grep',
      toolArgs: { pattern: 'handleError', path: 'src/' },
    });
    expect(query).toContain('handleError');
  });

  it('inherits intent from previous calls', () => {
    const query = buildQuery({
      toolName: 'browser_snapshot',
      toolArgs: {},
      previousCalls: [
        {
          toolName: 'browser_navigate',
          toolArgs: { url: 'https://react.dev/reference/useState' },
        },
      ],
    });
    expect(query).toContain('useState');
    expect(query).toContain('react.dev');
  });

  it('handles missing args gracefully', () => {
    const query = buildQuery({ toolName: 'some_tool' });
    expect(query).toBe('some tool');
  });
});
