import { estimateTokens } from './classifier.js';

export interface Chunk {
  text: string;
  index: number;
  tokens: number;
}

const DEFAULT_TARGET_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 50;
const SPLIT_SEPARATORS = ['\n\n', '\n', '. ', ' '];

function splitBySeparator(text: string, separator: string): string[] {
  const parts = text.split(separator);
  return parts
    .map((part, i) => (i < parts.length - 1 ? part + separator : part))
    .filter((p) => p.length > 0);
}

export function chunkText(
  text: string,
  targetTokens = DEFAULT_TARGET_TOKENS,
  overlapTokens = DEFAULT_OVERLAP_TOKENS,
): Chunk[] {
  const totalTokens = estimateTokens(text);
  if (totalTokens <= targetTokens) {
    return [{ text, index: 0, tokens: totalTokens }];
  }

  const overlapChars = overlapTokens * 4;

  // Recursive splitting: break by largest separator first
  let segments = [text];
  for (const sep of SPLIT_SEPARATORS) {
    const newSegments: string[] = [];
    for (const segment of segments) {
      if (estimateTokens(segment) > targetTokens) {
        newSegments.push(...splitBySeparator(segment, sep));
      } else {
        newSegments.push(segment);
      }
    }
    segments = newSegments;
  }

  // Hard-split any segments still over target (no separators found)
  const finalSegments: string[] = [];
  const targetChars = targetTokens * 4;
  for (const segment of segments) {
    if (segment.length > targetChars * 1.5) {
      for (let i = 0; i < segment.length; i += targetChars) {
        finalSegments.push(segment.slice(i, i + targetChars));
      }
    } else {
      finalSegments.push(segment);
    }
  }

  // Merge small segments into chunks of ~targetTokens with overlap
  const chunks: Chunk[] = [];
  let current = '';

  for (const segment of finalSegments) {
    if (estimateTokens(current + segment) > targetTokens && current.length > 0) {
      chunks.push({
        text: current,
        index: chunks.length,
        tokens: estimateTokens(current),
      });
      const overlapBuffer = current.slice(-overlapChars);
      current = overlapBuffer + segment;
    } else {
      current += segment;
    }
  }

  if (current.length > 0) {
    chunks.push({
      text: current,
      index: chunks.length,
      tokens: estimateTokens(current),
    });
  }

  return chunks;
}
