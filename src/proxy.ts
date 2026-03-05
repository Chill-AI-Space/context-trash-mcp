import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Config } from './config.js';
import { compressResult } from './pipeline.js';
import { log, logError } from './logger.js';
import { recordCall, getRecentCalls } from './session.js';
import { ToolContext } from './query-builder.js';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingCall {
  toolName: string;
  toolArgs?: Record<string, unknown>;
}

/**
 * Track pending tool call requests so we know which tool name + args
 * corresponds to which response id.
 */
const pendingCalls = new Map<number | string, PendingCall>();

function isToolCallRequest(msg: JsonRpcMessage): boolean {
  return msg.method === 'tools/call';
}

function isResponse(msg: JsonRpcMessage): boolean {
  return msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined);
}

export function startProxy(wrappedCommand: string, config: Config): void {
  const parts = wrappedCommand.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!parts || parts.length === 0) {
    logError(`Invalid wrap command: ${wrappedCommand}`);
    process.exit(1);
  }
  const cmd = parts[0];
  const args = parts.slice(1).map((a: string) => a.replace(/^"|"$/g, ''));

  log(`Spawning wrapped server: ${cmd} ${args.join(' ')}`);

  const child: ChildProcess = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env },
  });

  if (!child.stdin || !child.stdout) {
    logError('Failed to open stdio for wrapped server');
    process.exit(1);
  }

  // Claude → proxy → child
  const fromClaude = createInterface({ input: process.stdin, crlfDelay: Infinity });
  fromClaude.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const message: JsonRpcMessage = JSON.parse(trimmed);

      if (isToolCallRequest(message) && message.id !== undefined) {
        const params = message.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        if (params?.name) {
          pendingCalls.set(message.id, {
            toolName: params.name,
            toolArgs: params.arguments,
          });
          recordCall(params.name, params.arguments);
          log(`→ tools/call: ${params.name} (id=${message.id})`);
        }
      }

      child.stdin!.write(trimmed + '\n');
    } catch {
      // Not valid JSON — forward raw
      child.stdin!.write(line + '\n');
    }
  });

  // Sequential processing queue for async compression
  let processing = Promise.resolve();

  // Child → proxy → Claude
  const fromChild = createInterface({ input: child.stdout, crlfDelay: Infinity });
  fromChild.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Chain onto the processing queue to preserve message order
    processing = processing.then(async () => {
      try {
        const message: JsonRpcMessage = JSON.parse(trimmed);

        if (isResponse(message) && message.id !== undefined && pendingCalls.has(message.id)) {
          const pending = pendingCalls.get(message.id)!;
          pendingCalls.delete(message.id);

          if (message.result) {
            log(`← response for: ${pending.toolName} (id=${message.id})`);

            const toolContext: ToolContext = {
              toolName: pending.toolName,
              toolArgs: pending.toolArgs,
              previousCalls: getRecentCalls(3),
            };

            message.result = await compressResult(
              pending.toolName,
              message.result as Record<string, unknown>,
              config,
              toolContext,
            );
          }
        }

        process.stdout.write(JSON.stringify(message) + '\n');
      } catch {
        // Not valid JSON — forward raw
        process.stdout.write(line + '\n');
      }
    });
  });

  child.on('error', (err) => {
    logError(`Wrapped server error: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code) => {
    log(`Wrapped server exited with code ${code}`);
    process.exit(code ?? 0);
  });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}
