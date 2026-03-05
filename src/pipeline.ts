import { Config, findRule, Strategy } from './config.js';
import { classifyContent, ContentType, estimateTokens } from './classifier.js';
import { compressOCR } from './compressors/ocr.js';
import { compressDomCleanup } from './compressors/dom-cleanup.js';
import { compressTruncate } from './compressors/truncate.js';
import { log, logStats, logError } from './logger.js';

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
    case 'image': return 'passthrough'; // OCR only via explicit whitelist rules — safe for image generation MCP etc.
    case 'dom-snapshot': return 'dom-cleanup';
    case 'large-text': return 'truncate';
    case 'small-text': return 'passthrough';
  }
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

function compressBlock(
  block: ContentBlock,
  strategy: Strategy,
  config: Config,
): ContentBlock {
  switch (strategy) {
    case 'ocr':
      return compressOCR(block, config.ocrEngine);
    case 'dom-cleanup':
      return compressDomCleanup(block);
    case 'truncate':
      return compressTruncate(block, config.maxTextTokens);
    case 'passthrough':
      return block;
    case 'auto': {
      const contentType = classifyContent(block, config.threshold, config.maxTextTokens);
      const autoStrategy = strategyForContentType(contentType);
      return compressBlock(block, autoStrategy, config);
    }
  }
}

export function compressResult(
  toolName: string,
  result: CallToolResult,
  config: Config,
): CallToolResult {
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

  // Compress each block
  const compressedContent = result.content.map((block) => {
    try {
      const effectiveConfig = maxTokens !== config.maxTextTokens
        ? { ...config, maxTextTokens: maxTokens }
        : config;
      return compressBlock(block, strategy, effectiveConfig);
    } catch (err) {
      logError(`Compressor failed for ${toolName}: ${err}`);
      return block; // fail-safe: return original
    }
  });

  const totalAfter = compressedContent.reduce((sum, b) => sum + blockTokenEstimate(b), 0);

  // If compression made result significantly larger (>10%), return original
  // Exception: OCR (changes type) and explicit rules (user chose this strategy)
  if (totalAfter > totalBefore * 1.1 && strategy === 'auto') {
    log(`${toolName}: compression increased size (${totalBefore} → ${totalAfter}), keeping original`);
    return result;
  }

  logStats(toolName, totalBefore, totalAfter);

  return { ...result, content: compressedContent };
}
