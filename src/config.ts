import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type Strategy = 'ocr' | 'dom-cleanup' | 'json-collapse' | 'truncate' | 'auto' | 'passthrough';

export interface Rule {
  toolName?: string;
  toolNamePattern?: string;
  strategy: Strategy;
  maxTokens?: number;
  comment?: string;
}

export interface Config {
  // Enable image OCR — converts screenshots (base64) to extracted text.
  // A single screenshot is ~250k tokens as base64. OCR reduces to ~500 tokens.
  // Default: true.
  imageOcr: boolean;

  // Enable JSON collapse — schema-aware summarization of large JSON arrays/objects.
  // Keeps first 3 items + schema description, strips nulls/empties.
  // Doesn't lose structural information, safe to keep enabled.
  // Default: true.
  jsonCollapse: boolean;

  // Minimum text block size (in tokens) to trigger text compression.
  // Claude is smarter than the compression model — don't dumb down small inputs.
  // Only compress texts so large they'd waste context or risk compact.
  // Default: 100000 (100k tokens). Increase to compress less, decrease to compress more.
  textCompressionThreshold: number;

  // Gemini prompt for text compression.
  // Used when a text block exceeds textCompressionThreshold.
  // Must contain {TARGET} placeholder — replaced with target token count.
  compressionPrompt: string;

  ocrEngine: 'auto' | 'vision' | 'tesseract';
  verbose: boolean;
  dryRun: boolean;
  geminiApiKey?: string;
  rules: Rule[];
}

const DEFAULT_COMPRESSION_PROMPT = `Shorten this tool output while preserving all useful information.
Keep ALL: code blocks, file paths, URLs, error messages, data structures, identifiers, numbers, dates.
Remove: redundant explanations, boilerplate, verbose prose, repeated information.
Preserve original structure and ordering. When in doubt, keep the information.
Do NOT add commentary about the compression. Output ONLY the shortened text.
Target: approximately {TARGET} tokens.`;

const DEFAULT_CONFIG: Config = {
  imageOcr: true,
  jsonCollapse: true,
  textCompressionThreshold: 100_000,
  compressionPrompt: DEFAULT_COMPRESSION_PROMPT,
  ocrEngine: 'auto',
  verbose: false,
  dryRun: false,
  rules: [
    { toolName: 'browser_snapshot', strategy: 'dom-cleanup' },
    { toolName: 'puppeteer_snapshot', strategy: 'dom-cleanup' },
    { toolNamePattern: '.*', strategy: 'auto' },
  ],
};

export function loadConfig(configPath?: string): Config {
  const resolvedPath = configPath
    ?? path.join(os.homedir(), '.config', 'compress-on-input', 'config.json');

  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf-8');
      const userConfig = JSON.parse(raw);

      // Backwards compatibility
      if ('threshold' in userConfig && !('textCompressionThreshold' in userConfig)) {
        userConfig.textCompressionThreshold = userConfig.threshold;
      }
      if ('minBlockTokens' in userConfig && !('textCompressionThreshold' in userConfig)) {
        userConfig.textCompressionThreshold = userConfig.minBlockTokens;
      }

      return { ...DEFAULT_CONFIG, ...userConfig };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  return DEFAULT_CONFIG;
}

export function findRule(config: Config, toolName: string): Rule | undefined {
  for (const rule of config.rules) {
    if (rule.toolName && rule.toolName === toolName) {
      return rule;
    }
    if (rule.toolNamePattern && new RegExp(rule.toolNamePattern).test(toolName)) {
      return rule;
    }
  }
  return undefined;
}
