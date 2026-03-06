import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logAlways, logError } from './logger.js';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

interface HookHandler {
  type: string;
  command: string;
  timeout?: number;
}

interface MatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
}

interface Settings {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

const HOOK_COMMAND = 'compress-on-input --hook --verbose';
const HOOK_MATCHER = '.*';

function loadSettings(): Settings {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSettings(settings: Settings): void {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function isCompressOnInputHook(handler: HookHandler): boolean {
  return handler.command.includes('compress-on-input');
}

export function installHook(): void {
  const settings = loadSettings();

  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks.PostToolUse) {
    settings.hooks.PostToolUse = [];
  }

  // Check if already installed
  const existing = settings.hooks.PostToolUse.some(
    (group) => group.hooks?.some(isCompressOnInputHook),
  );

  if (existing) {
    logAlways('compress-on-input hook is already installed.');
    return;
  }

  settings.hooks.PostToolUse.push({
    matcher: HOOK_MATCHER,
    hooks: [
      {
        type: 'command',
        command: HOOK_COMMAND,
        timeout: 15,
      },
    ],
  });

  saveSettings(settings);
  logAlways('compress-on-input hook installed in ~/.claude/settings.json');
  logAlways('Matcher: .* (all tool results)');
  logAlways('Restart Claude Code for the hook to take effect.');
}

export function uninstallHook(): void {
  const settings = loadSettings();

  if (!settings.hooks?.PostToolUse) {
    logAlways('No compress-on-input hook found.');
    return;
  }

  const before = settings.hooks.PostToolUse.length;
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
    (group) => !group.hooks?.some(isCompressOnInputHook),
  );

  if (settings.hooks.PostToolUse.length === before) {
    logAlways('No compress-on-input hook found.');
    return;
  }

  // Clean up empty arrays
  if (settings.hooks.PostToolUse.length === 0) {
    delete settings.hooks.PostToolUse;
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  saveSettings(settings);
  logAlways('compress-on-input hook removed from ~/.claude/settings.json');
  logAlways('Restart Claude Code for changes to take effect.');
}
