import * as fs from 'node:fs';
import { Config, loadConfig } from './config.js';
import { compressResult } from './pipeline.js';
import { setVerbose, log, logError } from './logger.js';
import { ToolContext } from './query-builder.js';
import { recordCall, getRecentCalls } from './session.js';

/**
 * PostToolUse hook handler for Claude Code.
 *
 * Receives JSON on stdin with tool_name, tool_input, tool_response.
 * For MCP tools: outputs JSON with updatedMCPToolOutput to replace the tool's output.
 * For built-in tools: outputs JSON with additionalContext.
 *
 * Usage in ~/.claude/settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse": [{
 *       "matcher": "mcp__playwright__.*",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "context-trash-mcp --hook"
 *       }]
 *     }]
 *   }
 * }
 */

interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  tool_use_id?: string;
}

// Claude context window is ~200k tokens ≈ ~800KB of JSONL text.
// But JSONL includes base64 images which inflate size dramatically.
// Heuristic: compact typically fires at ~167k tokens.
// JSONL file size / 4 ≈ rough token estimate (text portions).
// We use transcript file size as proxy: >50% of typical compact threshold.
//
// Typical JSONL sizes at compact time: 1-5MB (with screenshots much larger).
// Conservative: activate compression when JSONL > 400KB (~100k tokens of text).
const DEFAULT_ACTIVATION_BYTES = 400_000; // ~100k tokens

/**
 * Check if context is sufficiently full to warrant compression.
 * Uses transcript file size as a proxy for context usage.
 * Returns true if context is >50% full (or if we can't determine size).
 *
 * Exception: screenshots (images) are ALWAYS compressed regardless of context fill,
 * because a single screenshot is ~250k tokens — it can fill context in one shot.
 */
function shouldActivate(transcriptPath: string | undefined, hasImages: boolean, activationBytes: number): boolean {
  // Always compress images — they're 250k tokens each
  if (hasImages) return true;

  if (!transcriptPath) return true; // can't determine → compress to be safe

  try {
    const stat = fs.statSync(transcriptPath);
    const size = stat.size;
    log(`Transcript size: ${(size / 1024).toFixed(0)}KB`);

    if (size < activationBytes) {
      log(`Context below activation threshold (${(activationBytes / 1024).toFixed(0)}KB), skipping compression`);
      return false;
    }
    return true;
  } catch {
    return true; // can't stat → compress to be safe
  }
}

function isMCPTool(toolName: string): boolean {
  return toolName.startsWith('mcp__');
}

/**
 * Extract the short tool name from MCP tool name.
 * mcp__playwright__browser_take_screenshot → browser_take_screenshot
 */
function shortToolName(toolName: string): string {
  if (!isMCPTool(toolName)) return toolName;
  const parts = toolName.split('__');
  return parts.length >= 3 ? parts.slice(2).join('__') : toolName;
}

/**
 * Normalize tool_response into our ContentBlock[] format.
 * MCP tool responses can be:
 * - { content: [{ type: "text", text: "..." }, { type: "image", data: "...", mimeType: "..." }] }
 * - A plain string
 * - An object with other shapes
 */
function normalizeResponse(response: unknown): { content: ContentBlock[] } | null {
  if (!response) return null;

  // Array of content blocks directly (e.g., MCP tool responses via hooks)
  if (Array.isArray(response)) {
    if (response.length === 0) return null;
    // Check if it looks like content blocks
    if (typeof response[0] === 'object' && response[0] !== null && 'type' in response[0]) {
      return { content: response as ContentBlock[] };
    }
    // Array of something else — wrap as JSON text
    const text = JSON.stringify(response);
    return { content: [{ type: 'text', text }] };
  }

  if (typeof response === 'object' && response !== null) {
    const r = response as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      return { content: r.content as ContentBlock[] };
    }
    // Single content block
    if (typeof r.type === 'string') {
      return { content: [r as unknown as ContentBlock] };
    }
    // Wrap as text
    const text = JSON.stringify(response);
    return { content: [{ type: 'text', text }] };
  }

  if (typeof response === 'string') {
    return { content: [{ type: 'text', text: response }] };
  }

  return null;
}

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export async function handleHook(configOrPath?: Config | string): Promise<void> {
  const config = typeof configOrPath === 'object' && configOrPath !== null
    ? configOrPath
    : loadConfig(configOrPath);
  setVerbose(config.verbose);

  // Read JSON from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const rawInput = Buffer.concat(chunks).toString('utf-8').trim();

  if (!rawInput) {
    process.exit(0);
  }

  let input: HookInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    logError('Failed to parse hook input JSON');
    process.exit(0); // non-blocking: exit 0 to not interfere
  }

  const { tool_name, tool_input, tool_response } = input;

  log(`Hook: ${tool_name}`);

  // Track this call for session context (intent inheritance)
  const shortName = shortToolName(tool_name);
  recordCall(shortName, tool_input);

  // Normalize response to our format
  const normalized = normalizeResponse(tool_response);
  if (!normalized) {
    log(`Hook: ${tool_name} — no content to compress`);
    process.exit(0);
  }

  // Check if context is full enough to warrant compression
  const hasImages = normalized.content.some((b: ContentBlock) => b.type === 'image');
  if (!shouldActivate(input.transcript_path, hasImages, config.activationBytes)) {
    process.exit(0);
  }

  // Build tool context for BM25 relevance ranking
  const toolContext: ToolContext = {
    toolName: shortName,
    toolArgs: tool_input,
    previousCalls: getRecentCalls(3),
  };

  // Run through the compression pipeline
  const compressed = await compressResult(shortName, normalized, config, toolContext);

  // If nothing changed (pipeline returned the same object), exit silently
  if (compressed === normalized) {
    log(`Hook: ${tool_name} — no compression needed`);
    process.exit(0);
  }

  // Output the hook response
  if (isMCPTool(tool_name)) {
    // For MCP tools: use updatedMCPToolOutput to replace the tool's output
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedMCPToolOutput: compressed,
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
  } else {
    // For built-in tools: use additionalContext to append compressed version
    // (built-in tools don't support updatedMCPToolOutput)
    const textContent = compressed.content
      ?.filter((b: ContentBlock) => b.type === 'text' && b.text)
      .map((b: ContentBlock) => b.text)
      .join('\n');

    if (textContent) {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `[Compressed by Context Trash]\n${textContent}`,
        },
      };
      process.stdout.write(JSON.stringify(output) + '\n');
    }
  }
}
