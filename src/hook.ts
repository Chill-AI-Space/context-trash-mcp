import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Config, loadConfig } from './config.js';
import { compressResult } from './pipeline.js';
import { setVerbose, log, logError } from './logger.js';
import { ToolContext } from './query-builder.js';
import { recordCall, getRecentCalls } from './session.js';

const DEBUG_LOG = path.join(os.homedir(), '.local', 'share', 'compress-on-input', 'debug.log');
function dbg(msg: string): void {
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}

/**
 * PostToolUse hook handler for Claude Code.
 *
 * Receives JSON on stdin with tool_name, tool_input, tool_response.
 * Only processes MCP tools (outputs updatedMCPToolOutput to replace output).
 * Built-in tools are skipped — they only support additionalContext which adds tokens.
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

function isMCPTool(toolName: string): boolean {
  return toolName.startsWith('mcp__');
}

function shortToolName(toolName: string): string {
  if (!isMCPTool(toolName)) return toolName;
  const parts = toolName.split('__');
  return parts.length >= 3 ? parts.slice(2).join('__') : toolName;
}

function flattenImageBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type !== 'image' || block.data) return block;
    const src = (block as unknown as Record<string, unknown>).source;
    if (src && typeof src === 'object') {
      const s = src as Record<string, unknown>;
      if (typeof s.data === 'string') {
        return {
          type: 'image',
          data: s.data as string,
          mimeType: (s.media_type as string) ?? block.mimeType ?? 'image/png',
        };
      }
    }
    return block;
  });
}

function normalizeResponse(response: unknown): { content: ContentBlock[] } | null {
  if (!response) return null;

  if (Array.isArray(response)) {
    if (response.length === 0) return null;
    if (typeof response[0] === 'object' && response[0] !== null && 'type' in response[0]) {
      return { content: flattenImageBlocks(response as ContentBlock[]) };
    }
    const text = JSON.stringify(response);
    return { content: [{ type: 'text', text }] };
  }

  if (typeof response === 'object' && response !== null) {
    const r = response as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      return { content: flattenImageBlocks(r.content as ContentBlock[]) };
    }
    if (typeof r.type === 'string') {
      return { content: flattenImageBlocks([r as unknown as ContentBlock]) };
    }
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

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const rawInput = Buffer.concat(chunks).toString('utf-8').trim();

  dbg(`hook started, stdin chunks=${chunks.length}, rawInput=${rawInput.length} bytes`);

  if (!rawInput) {
    dbg('empty stdin, exit');
    process.exit(0);
  }

  let input: HookInput;
  try {
    input = JSON.parse(rawInput);
  } catch (e) {
    dbg(`JSON parse error: ${e}`);
    logError('Failed to parse hook input JSON');
    process.exit(0);
  }

  const { tool_name, tool_input, tool_response } = input;

  dbg(`tool=${tool_name} session=${input.session_id} transcript=${input.transcript_path} response_type=${typeof tool_response} response_is_array=${Array.isArray(tool_response)}`);
  if (tool_response && typeof tool_response === 'object') {
    const keys = Object.keys(tool_response as Record<string, unknown>).slice(0, 5);
    dbg(`response keys=[${keys}] ${Array.isArray(tool_response) ? `len=${(tool_response as unknown[]).length}` : ''}`);
  }

  log(`Hook: ${tool_name}`);

  const shortName = shortToolName(tool_name);
  recordCall(shortName, tool_input);

  // Skip built-in tools — they don't support updatedMCPToolOutput
  if (!isMCPTool(tool_name)) {
    dbg(`${tool_name}: built-in tool, skipping`);
    log(`Hook: ${tool_name} — built-in tool, skipping`);
    process.exit(0);
  }

  const normalized = normalizeResponse(tool_response);
  if (!normalized) {
    dbg(`${tool_name}: normalizeResponse returned null, exit`);
    log(`Hook: ${tool_name} — no content to compress`);
    process.exit(0);
  }

  dbg(`${tool_name}: normalized blocks=${normalized.content.length} types=[${normalized.content.map(b => b.type)}]`);
  for (const b of normalized.content) {
    const keys = Object.keys(b);
    const hasData = 'data' in b;
    const dataLen = b.data ? b.data.length : 0;
    const textLen = b.text ? b.text.length : 0;
    dbg(`  block: type=${b.type} keys=[${keys}] hasData=${hasData} dataLen=${dataLen} textLen=${textLen}`);
  }

  const toolContext: ToolContext = {
    toolName: shortName,
    toolArgs: tool_input,
    previousCalls: getRecentCalls(3),
  };

  let compressed;
  try {
    compressed = await compressResult(shortName, normalized, config, toolContext);
    dbg(`${tool_name}: compression done`);
  } catch (e) {
    dbg(`${tool_name}: compression THREW: ${e}`);
    process.exit(0);
  }

  if (compressed === normalized) {
    dbg(`${tool_name}: no change, exit`);
    log(`Hook: ${tool_name} — no compression needed`);
    process.exit(0);
  }

  dbg(`${tool_name}: outputting result`);

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedMCPToolOutput: compressed,
    },
  };
  process.stdout.write(JSON.stringify(output) + '\n');
}
