import { estimateTokens } from '../classifier.js';
import { chunkText } from '../chunker.js';
import { rankBM25 } from '../bm25.js';
import { buildQuery, ToolContext } from '../query-builder.js';
import { compressWithGemini } from './gemini.js';
import { log } from '../logger.js';

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

// Compression ratio: target = originalTokens × RATIO
const RATIO = 0.5;

// Generous head/tail for large texts — preserve context at boundaries
const HEAD_TOKENS = 10_000;
const TAIL_TOKENS = 5_000;

// Below this, Gemini overhead > savings
const MIN_GEMINI_INPUT = 5_000;

/**
 * Split text into head, middle, tail by token budget.
 */
function splitHeadMiddleTail(
  text: string,
  headTokens: number,
  tailTokens: number,
): { head: string; middle: string; tail: string } {
  const headChars = headTokens * 4;
  const tailChars = tailTokens * 4;

  if (text.length <= headChars + tailChars) {
    return { head: text, middle: '', tail: '' };
  }

  let headEnd = headChars;
  const headNewline = text.indexOf('\n', headChars - 200);
  if (headNewline > 0 && headNewline < headChars + 200) {
    headEnd = headNewline + 1;
  }

  let tailStart = text.length - tailChars;
  const tailNewline = text.lastIndexOf('\n', tailStart + 200);
  if (tailNewline > tailStart - 200 && tailNewline > headEnd) {
    tailStart = tailNewline + 1;
  }

  if (tailStart <= headEnd) {
    return { head: text, middle: '', tail: '' };
  }

  return {
    head: text.slice(0, headEnd),
    middle: text.slice(headEnd, tailStart),
    tail: text.slice(tailStart),
  };
}

/**
 * Select top BM25-ranked chunks preserving original order, up to token budget.
 */
function selectTopChunks(
  ranked: Array<{ item: { text: string; tokens: number; index: number }; score: number }>,
  tokenBudget: number,
): string {
  let remaining = tokenBudget;
  const selected: Array<{ text: string; index: number }> = [];

  for (const r of ranked) {
    if (r.item.tokens <= remaining) {
      selected.push({ text: r.item.text, index: r.item.index });
      remaining -= r.item.tokens;
    }
    if (remaining <= 0) break;
  }

  selected.sort((a, b) => a.index - b.index);
  return selected.map((s) => s.text).join('');
}

/**
 * BM25 compress: chunk text, rank by relevance, select top chunks to budget.
 */
function bm25Compress(text: string, targetTokens: number, toolContext?: ToolContext): string {
  const query = toolContext ? buildQuery(toolContext) : '';
  const chunks = chunkText(text);

  const ranked = query.length > 0
    ? rankBM25(chunks, (c) => c.text, query)
    : chunks.map((c, i) => ({ item: c, score: 0, index: i }));

  log(`BM25: ${chunks.length} chunks, target=${targetTokens}, query="${query.slice(0, 80)}${query.length > 80 ? '...' : ''}"`);

  return selectTopChunks(ranked, targetTokens);
}

/**
 * Compress very large text blocks (100k+ tokens by default).
 *
 * Only called for texts above textCompressionThreshold.
 * Preserves generous head (10k) and tail (5k), compresses middle to ~50%.
 *
 * Pipeline: head + [BM25 → Gemini] middle + tail
 */
export async function compressTruncate(
  block: ContentBlock,
  promptTemplate: string,
  toolContext?: ToolContext,
  geminiApiKey?: string,
): Promise<ContentBlock> {
  if (block.type !== 'text' || !block.text) return block;

  const text = block.text;
  const totalTokens = estimateTokens(text);
  const targetTokens = Math.round(totalTokens * RATIO);

  if (totalTokens <= targetTokens) return block;

  log(`Truncate: ${totalTokens} tokens → target ${targetTokens} (${Math.round(RATIO * 100)}%)`);

  const { head, middle, tail } = splitHeadMiddleTail(text, HEAD_TOKENS, TAIL_TOKENS);

  if (!middle) {
    // Text fits in head+tail — no middle to compress
    return block;
  }

  const middleTokens = estimateTokens(middle);
  const middleTarget = Math.max(
    Math.round(targetTokens - estimateTokens(head) - estimateTokens(tail)),
    1000,
  );

  log(`Truncate: head=${estimateTokens(head)}, middle=${middleTokens}, tail=${estimateTokens(tail)}, middleTarget=${middleTarget}`);

  let compressedMiddle: string;

  // Step 1: BM25 pre-selection if middle is much larger than target
  if (middleTokens > middleTarget * 3) {
    const bm25Target = geminiApiKey ? middleTarget * 2 : middleTarget;
    compressedMiddle = bm25Compress(middle, bm25Target, toolContext);
  } else {
    compressedMiddle = middle;
  }

  // Step 2: Gemini compression if available and worthwhile
  const afterBm25 = estimateTokens(compressedMiddle);
  if (geminiApiKey && afterBm25 > middleTarget && afterBm25 >= MIN_GEMINI_INPUT) {
    const geminiResult = await compressWithGemini(compressedMiddle, middleTarget, geminiApiKey, promptTemplate);
    if (geminiResult) {
      compressedMiddle = geminiResult;
    } else if (afterBm25 > middleTarget) {
      compressedMiddle = bm25Compress(middle, middleTarget, toolContext);
    }
  } else if (afterBm25 > middleTarget) {
    compressedMiddle = bm25Compress(middle, middleTarget, toolContext);
  }

  const finalMiddle = estimateTokens(compressedMiddle);
  const marker = `\n[... middle compressed: ${middleTokens.toLocaleString()}→${finalMiddle.toLocaleString()} tokens ...]\n`;

  return { type: 'text', text: head + marker + compressedMiddle + tail };
}

/**
 * Sync version — BM25 only, no Gemini.
 */
export function compressTruncateSync(
  block: ContentBlock,
  toolContext?: ToolContext,
): ContentBlock {
  if (block.type !== 'text' || !block.text) return block;

  const text = block.text;
  const totalTokens = estimateTokens(text);
  const targetTokens = Math.round(totalTokens * RATIO);

  if (totalTokens <= targetTokens) return block;

  const { head, middle, tail } = splitHeadMiddleTail(text, HEAD_TOKENS, TAIL_TOKENS);
  if (!middle) return block;

  const middleTokens = estimateTokens(middle);
  const middleTarget = Math.max(
    Math.round(targetTokens - estimateTokens(head) - estimateTokens(tail)),
    1000,
  );

  const compressedMiddle = bm25Compress(middle, middleTarget, toolContext);
  const finalMiddle = estimateTokens(compressedMiddle);
  const marker = `\n[... middle compressed: ${middleTokens.toLocaleString()}→${finalMiddle.toLocaleString()} tokens ...]\n`;

  return { type: 'text', text: head + marker + compressedMiddle + tail };
}
