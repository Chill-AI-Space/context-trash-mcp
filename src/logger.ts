import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const PREFIX = '[context-trash]';
const LOG_DIR = path.join(os.homedir(), '.local', 'share', 'context-trash');
const LOG_FILE = path.join(LOG_DIR, 'events.jsonl');

let verboseEnabled = false;
let logDirReady = false;

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

export function log(message: string): void {
  if (verboseEnabled) {
    process.stderr.write(`${PREFIX} ${message}\n`);
  }
}

export function logAlways(message: string): void {
  process.stderr.write(`${PREFIX} ${message}\n`);
}

export function logError(message: string): void {
  process.stderr.write(`${PREFIX} ERROR: ${message}\n`);
}

export interface EventRecord {
  ts: string;
  tool: string;
  strategy: string;
  before: number;
  after: number;
  reduction: string;
  duration_ms: number;
  content_type?: string;
}

function ensureLogDir(): void {
  if (logDirReady) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logDirReady = true;
  } catch {
    // silently fail — logging should never break compression
  }
}

export function logEvent(event: EventRecord): void {
  ensureLogDir();
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(event) + '\n');
  } catch {
    // silently fail
  }
}

export function logStats(
  toolName: string,
  beforeTokens: number,
  afterTokens: number,
  strategy?: string,
  contentType?: string,
  startTime?: number,
): void {
  const reduction = ((1 - afterTokens / beforeTokens) * 100).toFixed(1);
  log(`${toolName}: ${beforeTokens.toLocaleString()} → ${afterTokens.toLocaleString()} tokens (${reduction}% reduction)`);

  const duration_ms = startTime ? Date.now() - startTime : 0;

  logEvent({
    ts: new Date().toISOString(),
    tool: toolName,
    strategy: strategy ?? 'auto',
    before: beforeTokens,
    after: afterTokens,
    reduction: `${reduction}%`,
    duration_ms,
    content_type: contentType,
  });
}
