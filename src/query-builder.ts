export interface ToolContext {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  previousCalls?: Array<{ toolName: string; toolArgs?: Record<string, unknown> }>;
}

function extractFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const pathParts = u.pathname
      .split('/')
      .filter((p) => p.length > 1)
      .map((p) => p.replace(/[-_]/g, ' '));
    return [...pathParts, u.hostname.replace('www.', '')].join(' ');
  } catch {
    return url;
  }
}

function extractFromPath(filePath: string): string {
  return filePath
    .split('/')
    .filter((p) => p.length > 0 && !p.startsWith('.'))
    .map((p) => p.replace(/[-_.]/g, ' ').replace(/\.\w+$/, ''))
    .join(' ');
}

function extractFromArgs(args: Record<string, unknown>): string[] {
  const keywords: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue;

    if (key === 'url' || key === 'uri' || key === 'href') {
      keywords.push(extractFromUrl(value));
    } else if (
      key === 'path' ||
      key === 'file' ||
      key === 'file_path' ||
      key === 'filepath'
    ) {
      keywords.push(extractFromPath(value));
    } else if (
      key === 'query' ||
      key === 'search' ||
      key === 'pattern' ||
      key === 'selector' ||
      key === 'command'
    ) {
      keywords.push(value);
    } else if (value.length < 200) {
      keywords.push(value);
    }
  }

  return keywords;
}

export function buildQuery(ctx: ToolContext): string {
  const parts: string[] = [];

  // Tool name (cleaned up)
  parts.push(ctx.toolName.replace(/[_-]/g, ' '));

  // Current tool args
  if (ctx.toolArgs) {
    parts.push(...extractFromArgs(ctx.toolArgs));
  }

  // Inherit intent from previous calls (e.g., navigate → snapshot)
  if (ctx.previousCalls && ctx.previousCalls.length > 0) {
    const recent = ctx.previousCalls.slice(-2);
    for (const call of recent) {
      if (call.toolArgs) {
        parts.push(...extractFromArgs(call.toolArgs));
      }
    }
  }

  return parts.join(' ').trim();
}
