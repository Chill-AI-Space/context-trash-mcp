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
  maxTextTokens?: number;
  threshold?: number;
  geminiApiKey?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { mode: 'proxy', verbose: false, dryRun: false };

  // Check for subcommands first
  if (args[0] === 'install') {
    result.mode = 'install';
    return result;
  }
  if (args[0] === 'uninstall') {
    result.mode = 'uninstall';
    return result;
  }
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    result.mode = 'help';
    return result;
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--hook':
        result.mode = 'hook';
        break;
      case '--wrap':
        result.wrap = args[++i];
        break;
      case '--config':
        result.config = args[++i];
        break;
      case '--verbose':
        result.verbose = true;
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--ocr-engine':
        result.ocrEngine = args[++i];
        break;
      case '--max-text-tokens':
        result.maxTextTokens = parseInt(args[++i], 10);
        break;
      case '--threshold':
        result.threshold = parseInt(args[++i], 10);
        break;
      case '--gemini-api-key':
        result.geminiApiKey = args[++i];
        break;
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
  logAlways(`context-trash-mcp — Compress bloated tool results before they enter Claude's context

MODES:
  Hook mode (recommended):
    context-trash-mcp --hook              Runs as Claude Code PostToolUse hook.
                                          Reads JSON from stdin, outputs compressed result.

  Proxy mode:
    context-trash-mcp --wrap "cmd args"   Wraps an MCP server, compresses results in transit.

  Install/uninstall:
    context-trash-mcp install             Add hook to ~/.claude/settings.json
    context-trash-mcp uninstall           Remove hook from ~/.claude/settings.json

OPTIONS:
  --config <path>          Path to config file (default: ~/.config/context-trash/config.json)
  --verbose                Log compression stats to stderr
  --dry-run                Log what would be compressed without modifying results
  --ocr-engine <engine>    auto | vision | tesseract (default: auto)
  --max-text-tokens <n>    Max tokens for text content before truncation (default: 2000)
  --threshold <n>          Min token estimate to trigger compression (default: 500)
  --gemini-api-key <key>   Gemini API key for smart compression (or set GEMINI_API_KEY env var)

QUICK START:
  npx context-trash-mcp install          # One-time setup
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
      const hookConfig = loadConfig(args.config);
      if (args.verbose) hookConfig.verbose = true;
      if (args.dryRun) hookConfig.dryRun = true;
      if (args.ocrEngine) hookConfig.ocrEngine = args.ocrEngine as typeof hookConfig.ocrEngine;
      if (args.maxTextTokens) hookConfig.maxTextTokens = args.maxTextTokens;
      if (args.threshold) hookConfig.threshold = args.threshold;
      hookConfig.geminiApiKey = args.geminiApiKey ?? process.env.GEMINI_API_KEY ?? hookConfig.geminiApiKey;
      await handleHook(hookConfig);
      break;
    }

    case 'proxy': {
      if (!args.wrap) {
        logError('Missing --wrap flag. Use --hook for hook mode, or --wrap "cmd" for proxy mode.');
        logError('Run context-trash-mcp --help for usage.');
        process.exit(1);
      }

      const config = loadConfig(args.config);
      if (args.verbose) config.verbose = true;
      if (args.dryRun) config.dryRun = true;
      if (args.ocrEngine) config.ocrEngine = args.ocrEngine as typeof config.ocrEngine;
      if (args.maxTextTokens) config.maxTextTokens = args.maxTextTokens;
      if (args.threshold) config.threshold = args.threshold;
      config.geminiApiKey = args.geminiApiKey ?? process.env.GEMINI_API_KEY ?? config.geminiApiKey;

      setVerbose(config.verbose);
      logAlways(`Wrapping: ${args.wrap}`);
      logAlways(`Threshold: ${config.threshold} tokens, Max text: ${config.maxTextTokens} tokens`);

      startProxy(args.wrap, config);
      break;
    }
  }
}

main();
