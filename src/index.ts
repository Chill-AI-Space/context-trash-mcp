#!/usr/bin/env node

import { loadConfig } from './config.js';
import { setVerbose, logAlways, logError } from './logger.js';
import { startProxy } from './proxy.js';
import { handleHook } from './hook.js';
import { installHook, uninstallHook } from './install.js';

interface ParsedArgs {
  mode: 'proxy' | 'hook' | 'install' | 'uninstall' | 'help';
  wrap?: string;
  config?: string;
  verbose: boolean;
  dryRun: boolean;
  ocrEngine?: string;
  textThreshold?: number;
  geminiApiKey?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { mode: 'proxy', verbose: false, dryRun: false };

  if (args[0] === 'install') { result.mode = 'install'; return result; }
  if (args[0] === 'uninstall') { result.mode = 'uninstall'; return result; }
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') { result.mode = 'help'; return result; }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--hook': result.mode = 'hook'; break;
      case '--wrap': result.wrap = args[++i]; break;
      case '--config': result.config = args[++i]; break;
      case '--verbose': result.verbose = true; break;
      case '--dry-run': result.dryRun = true; break;
      case '--ocr-engine': result.ocrEngine = args[++i]; break;
      case '--text-threshold': result.textThreshold = parseInt(args[++i], 10); break;
      case '--gemini-api-key': result.geminiApiKey = args[++i]; break;
      // Deprecated flags — silently ignore
      case '--threshold': case '--max-text-tokens': case '--min-block-tokens':
      case '--activation-bytes': case '--aggressive-percent':
        i++; break;
      default:
        if (args[i].startsWith('-')) {
          logError(`Unknown flag: ${args[i]}`);
          process.exit(1);
        }
    }
  }

  return result;
}

function printHelp(): void {
  logAlways(`compress-on-input — Compress bloated tool results before they enter Claude's context

MODES:
  Hook mode (recommended):
    compress-on-input --hook              Runs as Claude Code PostToolUse hook.
                                          Reads JSON from stdin, outputs compressed result.

  Proxy mode:
    compress-on-input --wrap "cmd args"   Wraps an MCP server, compresses results in transit.

  Install/uninstall:
    compress-on-input install             Add hook to ~/.claude/settings.json
    compress-on-input uninstall           Remove hook from ~/.claude/settings.json

WHAT GETS COMPRESSED:
  Screenshots (base64)   → OCR text extraction (~99% reduction)
  DOM snapshots          → Cleanup + ref mapping (~50-70% reduction)
  Large JSON arrays      → Schema-aware collapse (~60-90% reduction)
  Huge text (>100k tok)  → BM25 + Gemini smart compression (~50% reduction)
  Everything else        → Untouched (Claude is smart, don't dumb down input)

OPTIONS:
  --config <path>             Config file (default: ~/.config/compress-on-input/config.json)
  --verbose                   Log compression stats to stderr
  --dry-run                   Log without modifying results
  --ocr-engine <engine>       auto | vision | tesseract (default: auto)
  --text-threshold <n>        Min tokens for text compression (default: 100000)
  --gemini-api-key <key>      Gemini API key (or set GEMINI_API_KEY env var)

QUICK START:
  npx compress-on-input install          # One-time setup
  # Restart Claude Code — done!`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.mode) {
    case 'help':
      printHelp();
      break;

    case 'install':
      installHook();
      break;

    case 'uninstall':
      uninstallHook();
      break;

    case 'hook': {
      const config = loadConfig(args.config);
      if (args.verbose) config.verbose = true;
      if (args.dryRun) config.dryRun = true;
      if (args.ocrEngine) config.ocrEngine = args.ocrEngine as typeof config.ocrEngine;
      if (args.textThreshold) config.textCompressionThreshold = args.textThreshold;
      config.geminiApiKey = args.geminiApiKey ?? process.env.GEMINI_API_KEY ?? config.geminiApiKey;
      await handleHook(config);
      break;
    }

    case 'proxy': {
      if (!args.wrap) {
        logError('Missing --wrap flag. Use --hook for hook mode, or --wrap "cmd" for proxy mode.');
        logError('Run compress-on-input --help for usage.');
        process.exit(1);
      }

      const config = loadConfig(args.config);
      if (args.verbose) config.verbose = true;
      if (args.dryRun) config.dryRun = true;
      if (args.ocrEngine) config.ocrEngine = args.ocrEngine as typeof config.ocrEngine;
      if (args.textThreshold) config.textCompressionThreshold = args.textThreshold;
      config.geminiApiKey = args.geminiApiKey ?? process.env.GEMINI_API_KEY ?? config.geminiApiKey;

      setVerbose(config.verbose);
      logAlways(`Wrapping: ${args.wrap}`);
      logAlways(`Text threshold: ${config.textCompressionThreshold.toLocaleString()} tokens, OCR: ${config.imageOcr}, JSON collapse: ${config.jsonCollapse}`);

      startProxy(args.wrap, config);
      break;
    }
  }
}

main();
