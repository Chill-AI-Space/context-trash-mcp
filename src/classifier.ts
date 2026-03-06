export type ContentType = 'image' | 'dom-snapshot' | 'large-json' | 'large-text' | 'small-text';

const DOM_SIGNALS = ['[ref=', '- role:', 'role="', 'aria-'];

// Internal threshold for JSON collapse (not user-configurable).
// JSON collapse is safe and doesn't lose structural info, so we trigger it early.
const JSON_MIN_TOKENS = 500;

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / 4);
}

export function classifyContent(
  block: { type: string; text?: string; data?: string; mimeType?: string },
  textCompressionThreshold: number,
): ContentType {
  if (block.type === 'image') {
    return 'image';
  }

  const text = block.text ?? '';

  // Check for DOM snapshot signals
  const hasDomSignals = DOM_SIGNALS.some((signal) => text.includes(signal));
  if (hasDomSignals) {
    return 'dom-snapshot';
  }

  const tokens = estimateTokens(text);

  // Large text — only if above the (high) text compression threshold
  if (tokens > textCompressionThreshold) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return 'large-json';
    }
    return 'large-text';
  }

  // JSON collapse has a lower threshold (it's safe, doesn't lose info)
  if (tokens > JSON_MIN_TOKENS) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return 'large-json';
    }
  }

  return 'small-text';
}
