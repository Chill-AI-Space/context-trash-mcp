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

const PASSTHROUGH_THRESHOLD = 5000; // tokens — below this, don't touch
const HEAD_TOKENS = 2000;
const TAIL_TOKENS = 1000;
const BM25_TARGET = 50000; // BM25 reduces middle to this
const GEMINI_THRESHOLD = 20000; // middle above this goes to Gemini
const GEMINI_TARGET = 20000; // Gemini compresses middle to this

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

  // Try to split at newlines for cleaner boundaries
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
 * Select top chunks by BM25 score, preserving original order, up to token budget.
 */
function selectTopChunks(
  ranked: Array<{ item: { text: string; tokens: number; index: number }; score: number }>,
  tokenBudget: number,
): string {
  // Take highest-scored chunks that fit in budget
  let remaining = tokenBudget;
  const selected: Array<{ text: string; index: number }> = [];

  for (const r of ranked) {
    if (r.item.tokens <= remaining) {
      selected.push({ text: r.item.text, index: r.item.index });
      remaining -= r.item.tokens;
    }
    if (remaining <= 0) break;
  }

  // Restore original order
  selected.sort((a, b) => a.index - b.index);
  return selected.map((s) => s.text).join('');
}

/**
 * Smart text compression pipeline:
 * - ≤5k tokens → passthrough
 * - Split into head(2k) + middle + tail(1k)
 * - middle ≤20k → keep as-is
 * - middle 20k–50k → BM25 rank to 20k (or Gemini if available)
 * - middle >50k → BM25 to 50k → Gemini to 20k
 */
export async function compressTruncate(
  block: ContentBlock,
  maxTokens: number,
  toolContext?: ToolContext,
  geminiApiKey?: string,
): Promise<ContentBlock> {
  if (block.type !== 'text' || !block.text) return block;

  const text = block.text;
  const totalTokens = estimateTokens(text);

  if (totalTokens <= PASSTHROUGH_THRESHOLD) return block;

  const { head, middle, tail } = splitHeadMiddleTail(text, HEAD_TOKENS, TAIL_TOKENS);

  if (!middle) return block; // text fits in head+tail

  const middleTokens = estimateTokens(middle);
  log(`Smart truncate: total=${totalTokens}, head=${estimateTokens(head)}, middle=${middleTokens}, tail=${estimateTokens(tail)}`);

  // Middle is small enough — keep everything
  if (middleTokens <= GEMINI_THRESHOLD) {
    log(`Smart truncate: middle ≤${GEMINI_THRESHOLD} tokens, keeping as-is`);
    return { type: 'text', text: head + middle + tail };
  }

  // Build relevance query from tool context
  const query = toolContext ? buildQuery(toolContext) : '';
  const hasQuery = query.length > 0;

  // Chunk the middle section
  const chunks = chunkText(middle);
  log(`Smart truncate: ${chunks.length} chunks, query="${query.slice(0, 80)}${query.length > 80 ? '...' : ''}"`);

  // BM25 rank chunks (or keep order if no query)
  const ranked = hasQuery
    ? rankBM25(chunks, (c) => c.text, query)
    : chunks.map((c, i) => ({ item: c, score: 0, index: i }));

  // Determine target for BM25 selection
  let bm25Target: number;
  let needsGemini = false;

  if (middleTokens > BM25_TARGET) {
    // Very large: BM25 → 50k, then Gemini → 20k
    bm25Target = BM25_TARGET;
    needsGemini = true;
    log(`Smart truncate: BM25 → ${BM25_TARGET} tokens, then Gemini → ${GEMINI_TARGET}`);
  } else {
    // Medium: just need to get middle down to 20k
    if (geminiApiKey) {
      // Gemini available: keep more context, let Gemini compress intelligently
      bm25Target = middleTokens; // keep all, let Gemini handle it
      needsGemini = true;
      log(`Smart truncate: Gemini → ${GEMINI_TARGET} tokens`);
    } else {
      // No Gemini: BM25 directly to 20k
      bm25Target = GEMINI_TARGET;
      log(`Smart truncate: BM25 → ${GEMINI_TARGET} tokens (no Gemini key)`);
    }
  }

  // Select chunks via BM25
  let compressedMiddle = selectTopChunks(ranked, bm25Target);

  // Gemini compression pass
  if (needsGemini && geminiApiKey) {
    const middleAfterBm25 = estimateTokens(compressedMiddle);
    if (middleAfterBm25 > GEMINI_THRESHOLD) {
      const geminiResult = await compressWithGemini(compressedMiddle, GEMINI_TARGET, geminiApiKey);
      if (geminiResult) {
        compressedMiddle = geminiResult;
      } else {
        // Gemini failed — fallback to BM25-only reduction to 20k
        log('Smart truncate: Gemini failed, falling back to BM25-only');
        compressedMiddle = selectTopChunks(ranked, GEMINI_TARGET);
      }
    }
  }

  const finalMiddleTokens = estimateTokens(compressedMiddle);
  const droppedTokens = middleTokens - finalMiddleTokens;

  const marker = `\n[... compressed middle: ${middleTokens.toLocaleString()} → ${finalMiddleTokens.toLocaleString()} tokens, ${droppedTokens.toLocaleString()} dropped ...]\n`;

  return {
    type: 'text',
    text: head + marker + compressedMiddle + tail,
  };
}

/**
 * Sync version for backward compatibility — no Gemini, BM25 only.
 */
export function compressTruncateSync(
  block: ContentBlock,
  maxTokens: number,
  toolContext?: ToolContext,
): ContentBlock {
  if (block.type !== 'text' || !block.text) return block;

  const text = block.text;
  const totalTokens = estimateTokens(text);

  if (totalTokens <= PASSTHROUGH_THRESHOLD) return block;

  const { head, middle, tail } = splitHeadMiddleTail(text, HEAD_TOKENS, TAIL_TOKENS);
  if (!middle) return block;

  const middleTokens = estimateTokens(middle);

  if (middleTokens <= GEMINI_THRESHOLD) {
    return { type: 'text', text: head + middle + tail };
  }

  const query = toolContext ? buildQuery(toolContext) : '';
  const chunks = chunkText(middle);
  const ranked = query
    ? rankBM25(chunks, (c) => c.text, query)
    : chunks.map((c, i) => ({ item: c, score: 0, index: i }));

  const compressedMiddle = selectTopChunks(ranked, GEMINI_TARGET);
  const finalMiddleTokens = estimateTokens(compressedMiddle);
  const droppedTokens = middleTokens - finalMiddleTokens;

  const marker = `\n[... compressed middle: ${middleTokens.toLocaleString()} → ${finalMiddleTokens.toLocaleString()} tokens, ${droppedTokens.toLocaleString()} dropped ...]\n`;

  return {
    type: 'text',
    text: head + marker + compressedMiddle + tail,
  };
}
