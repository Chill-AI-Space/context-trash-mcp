import { Config, findRule, Strategy } from './config.js';
import { classifyContent, ContentType, estimateTokens } from './classifier.js';
import { compressOCR } from './compressors/ocr.js';
import { compressDomCleanup } from './compressors/dom-cleanup.js';
import { compressTruncate } from './compressors/truncate.js';
import { compressJsonCollapse } from './compressors/json-collapse.js';
import { log, logStats, logError } from './logger.js';
import { ToolContext } from './query-builder.js';

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

function strategyForContentType(contentType: ContentType): Strategy {
  switch (contentType) {
    case 'image': return 'ocr';
    case 'dom-snapshot': return 'dom-cleanup';
    case 'large-json': return 'json-collapse';
    case 'large-text': return 'truncate';
    case 'small-text': return 'passthrough';
  }
}

// File path patterns in text blocks: markdown links, bare paths, URLs to local files
const FILE_PATH_PATTERN = /(?:]\(|href=["']?|src=["']?)?\/?(?:\/[\w./-]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|tiff))/i;

function resultHasFilePath(content: ContentBlock[]): boolean {
  return content.some(
    (block) => block.type === 'text' && block.text && FILE_PATH_PATTERN.test(block.text),
  );
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
      return compressJsonCollapse(block, config.maxTextTokens);
    case 'truncate':
      return compressTruncate(block, config.maxTextTokens, toolContext, config.geminiApiKey);
    case 'passthrough':
      return block;
    case 'auto': {
      const contentType = classifyContent(block, config.threshold, config.maxTextTokens);
      const autoStrategy = strategyForContentType(contentType);
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

  // Estimate total tokens
  const totalBefore = result.content.reduce((sum, b) => sum + blockTokenEstimate(b), 0);

  // Below threshold — passthrough
  if (totalBefore < config.threshold) {
    log(`${toolName}: ${totalBefore} tokens (below threshold, passthrough)`);
    return result;
  }

  // Find matching rule
  const rule = findRule(config, toolName);
  const strategy: Strategy = rule?.strategy ?? 'auto';
  const maxTokens = rule?.maxTokens ?? config.maxTextTokens;

  log(`${toolName}: ${totalBefore.toLocaleString()} tokens, strategy=${strategy}`);

  if (config.dryRun) {
    log(`${toolName}: [dry-run] would compress with strategy=${strategy}`);
    return result;
  }

  // For auto strategy: only OCR images if result contains a file path (image is on disk)
  const hasFilePath = resultHasFilePath(result.content);

  // Compress each block
  const compressedContent: ContentBlock[] = [];
  for (const block of result.content) {
    try {
      let blockStrategy = strategy;

      // Auto + image + no file path = passthrough (base64 is the only copy)
      if (strategy === 'auto' && block.type === 'image' && !hasFilePath) {
        log(`${toolName}: image has no file path in result, keeping original`);
        blockStrategy = 'passthrough';
      }

      const effectiveConfig = maxTokens !== config.maxTextTokens
        ? { ...config, maxTextTokens: maxTokens }
        : config;
      const compressed = await compressBlock(block, blockStrategy, effectiveConfig, toolContext);
      compressedContent.push(compressed);
    } catch (err) {
      logError(`Compressor failed for ${toolName}: ${err}`);
      compressedContent.push(block); // fail-safe: return original
    }
  }

  const totalAfter = compressedContent.reduce((sum, b) => sum + blockTokenEstimate(b), 0);

  // If compression made result significantly larger (>10%), return original
  if (totalAfter > totalBefore * 1.1 && strategy === 'auto') {
    log(`${toolName}: compression increased size (${totalBefore} → ${totalAfter}), keeping original`);
    return result;
  }

  logStats(toolName, totalBefore, totalAfter);

  return { ...result, content: compressedContent };
}
