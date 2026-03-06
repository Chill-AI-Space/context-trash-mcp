import { Config, findRule, Strategy } from './config.js';
import { classifyContent, ContentType, estimateTokens } from './classifier.js';
import { compressOCR } from './compressors/ocr.js';
import { compressDomCleanup } from './compressors/dom-cleanup.js';
import { compressTruncate } from './compressors/truncate.js';
import { compressJsonCollapse } from './compressors/json-collapse.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { log, logStats, logError } from './logger.js';
import { ToolContext } from './query-builder.js';

const DEBUG_LOG = path.join(os.homedir(), '.local', 'share', 'compress-on-input', 'debug.log');
function dbg(msg: string): void {
  try { fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [pipeline] ${msg}\n`); } catch { /* */ }
}

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface CallToolResult {
  content?: ContentBlock[];
  [key: string]: unknown;
}

function strategyForContentType(contentType: ContentType, config: Config): Strategy {
  switch (contentType) {
    case 'image':
      return config.imageOcr ? 'ocr' : 'passthrough';
    case 'dom-snapshot':
      return 'dom-cleanup';
    case 'large-json':
      return config.jsonCollapse ? 'json-collapse' : 'passthrough';
    case 'large-text':
      return 'truncate';
    case 'small-text':
      return 'passthrough';
  }
}

const FILE_PATH_PATTERN = /(?:]\(|href=["']?|src=["']?)?\/?(?:\/[\w./-]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|tiff))/i;
const SCREENSHOT_TOOLS = ['browser_take_screenshot', 'browser_screenshot', 'screenshot', 'take_screenshot'];

function resultHasFilePath(content: ContentBlock[]): boolean {
  return content.some(
    (block) => block.type === 'text' && block.text && FILE_PATH_PATTERN.test(block.text),
  );
}

function isScreenshotTool(toolName: string): boolean {
  return SCREENSHOT_TOOLS.some((t) => toolName.includes(t));
}

function blockTokenEstimate(block: ContentBlock): number {
  if (block.type === 'image' && block.data) {
    return Math.ceil(block.data.length / 4);
  }
  if (block.text) {
    return estimateTokens(block.text);
  }
  return 0;
}

/**
 * Build a compact summary line prepended to the compressed result.
 * Claude sees this in context — helps understand what happened to the data.
 */
function buildCompressionSummary(
  toolName: string,
  totalBefore: number,
  totalAfter: number,
  typeStats: Record<string, { count: number; before: number; after: number; strategy: string }>,
): string {
  const ratio = totalBefore > 0 ? Math.round((1 - totalAfter / totalBefore) * 100) : 0;
  const parts: string[] = [];

  for (const [type, stats] of Object.entries(typeStats)) {
    if (type === 'small-text') continue;
    if (stats.before === stats.after) continue;
    const typeRatio = stats.before > 0 ? Math.round((1 - stats.after / stats.before) * 100) : 0;
    parts.push(`${type}: ${stats.count} block${stats.count > 1 ? 's' : ''}, ${stats.before.toLocaleString()}→${stats.after.toLocaleString()} tokens (-${typeRatio}%)`);
  }

  const skipped = typeStats['small-text'];
  if (skipped && skipped.count > 0) {
    parts.push(`${skipped.count} small block${skipped.count > 1 ? 's' : ''} unchanged`);
  }

  const breakdown = parts.length > 0 ? ' | ' + parts.join('; ') : '';
  return `[compress-on-input: ${totalBefore.toLocaleString()}→${totalAfter.toLocaleString()} tokens (-${ratio}%)${breakdown}]`;
}

async function compressBlock(
  block: ContentBlock,
  strategy: Strategy,
  config: Config,
  toolContext?: ToolContext,
): Promise<ContentBlock> {
  switch (strategy) {
    case 'ocr':
      return compressOCR(block, config.ocrEngine);
    case 'dom-cleanup':
      return compressDomCleanup(block);
    case 'json-collapse':
      return compressJsonCollapse(block, 500); // internal threshold
    case 'truncate':
      return compressTruncate(block, config.compressionPrompt, toolContext, config.geminiApiKey);
    case 'passthrough':
      return block;
    case 'auto': {
      const contentType = classifyContent(block, config.textCompressionThreshold);
      const autoStrategy = strategyForContentType(contentType, config);
      return compressBlock(block, autoStrategy, config, toolContext);
    }
  }
}

export async function compressResult(
  toolName: string,
  result: CallToolResult,
  config: Config,
  toolContext?: ToolContext,
): Promise<CallToolResult> {
  if (!result.content || !Array.isArray(result.content) || result.content.length === 0) {
    return result;
  }

  const totalBefore = result.content.reduce((sum, b) => sum + blockTokenEstimate(b), 0);

  dbg(`${toolName}: totalBefore=${totalBefore} textThreshold=${config.textCompressionThreshold}`);

  // Quick check: if nothing is compressible, skip
  const hasCompressible = result.content.some((b) => {
    if (b.type === 'image') return config.imageOcr;
    const ct = classifyContent(b, config.textCompressionThreshold);
    return ct !== 'small-text';
  });

  if (!hasCompressible) {
    dbg(`${toolName}: nothing compressible, passthrough`);
    return result;
  }

  const rule = findRule(config, toolName);
  const strategy: Strategy = rule?.strategy ?? 'auto';

  const startTime = Date.now();
  log(`${toolName}: ${totalBefore.toLocaleString()} tokens, strategy=${strategy}`);

  if (config.dryRun) {
    log(`${toolName}: [dry-run] would compress with strategy=${strategy}`);
    return result;
  }

  const hasFilePath = resultHasFilePath(result.content);
  const knownScreenshot = isScreenshotTool(toolName);

  // Classify and compress each block
  const compressedContent: ContentBlock[] = [];
  const typeStats: Record<string, { count: number; before: number; after: number; strategy: string }> = {};

  for (const block of result.content) {
    const blockBefore = blockTokenEstimate(block);
    const contentType = block.type === 'image' ? 'image' : classifyContent(block, config.textCompressionThreshold);

    try {
      let blockStrategy = strategy;

      // Auto + image + no file path + not a known screenshot tool = passthrough
      if (strategy === 'auto' && block.type === 'image' && !hasFilePath && !knownScreenshot) {
        log(`${toolName}: image has no file path in result, keeping original`);
        blockStrategy = 'passthrough';
      }

      const effectiveStrategy = blockStrategy === 'auto'
        ? strategyForContentType(contentType, config)
        : blockStrategy;
      const compressed = await compressBlock(block, blockStrategy, config, toolContext);
      const blockAfter = blockTokenEstimate(compressed);

      compressedContent.push(compressed);

      const typeKey = contentType === 'small-text' ? 'small-text' : contentType;
      if (!typeStats[typeKey]) {
        typeStats[typeKey] = { count: 0, before: 0, after: 0, strategy: effectiveStrategy };
      }
      typeStats[typeKey].count++;
      typeStats[typeKey].before += blockBefore;
      typeStats[typeKey].after += blockAfter;
    } catch (err) {
      logError(`Compressor failed for ${toolName}: ${err}`);
      compressedContent.push(block);
    }
  }

  const totalAfter = compressedContent.reduce((sum, b) => sum + blockTokenEstimate(b), 0);

  // If compression made it bigger, return original
  if (totalAfter > totalBefore * 1.1 && strategy === 'auto') {
    log(`${toolName}: compression increased size (${totalBefore} → ${totalAfter}), keeping original`);
    return result;
  }

  // If nothing actually changed, return original (no summary noise)
  if (totalAfter === totalBefore) {
    return result;
  }

  const dominantType = Object.entries(typeStats)
    .filter(([k]) => k !== 'small-text')
    .sort((a, b) => b[1].before - a[1].before)[0]?.[0] ?? 'small-text';

  logStats(toolName, totalBefore, totalAfter, strategy, dominantType, startTime);

  const summary = buildCompressionSummary(toolName, totalBefore, totalAfter, typeStats);
  const summaryBlock: ContentBlock = { type: 'text', text: summary };

  return { ...result, content: [summaryBlock, ...compressedContent] };
}
