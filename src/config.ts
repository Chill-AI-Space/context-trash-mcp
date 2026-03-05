import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type Strategy = 'ocr' | 'dom-cleanup' | 'truncate' | 'auto' | 'passthrough';

export interface Rule {
  toolName?: string;
  toolNamePattern?: string;
  strategy: Strategy;
  maxTokens?: number;
  comment?: string;
}

export interface Config {
  threshold: number;
  maxTextTokens: number;
  ocrEngine: 'auto' | 'vision' | 'tesseract';
  verbose: boolean;
  dryRun: boolean;
  rules: Rule[];
}

const DEFAULT_CONFIG: Config = {
  threshold: 500,
  maxTextTokens: 2000,
  ocrEngine: 'auto',
  verbose: false,
  dryRun: false,
  rules: [
    // Playwright MCP
    { toolName: 'browser_take_screenshot', strategy: 'ocr' },
    { toolName: 'browser_snapshot', strategy: 'dom-cleanup' },
    // Puppeteer MCP
    { toolName: 'puppeteer_screenshot', strategy: 'ocr' },
    { toolName: 'puppeteer_snapshot', strategy: 'dom-cleanup' },
    // Default: auto for text, passthrough for images (safe for image generation MCP etc.)
    { toolNamePattern: '.*', strategy: 'auto' },
  ],
};

export function loadConfig(configPath?: string): Config {
  const resolvedPath = configPath
    ?? path.join(os.homedir(), '.config', 'context-trash', 'config.json');

  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf-8');
      const userConfig = JSON.parse(raw);
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
