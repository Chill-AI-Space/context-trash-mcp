# context-trash-mcp

> Compress bloated tool results before they eat Claude's context window. Zero runtime dependencies.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-56%20passing-brightgreen)]()
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)]()

## Quick Start

```bash
# Install globally
npm install -g context-trash-mcp

# Add hook to Claude Code (one-time setup)
context-trash-mcp install

# Restart Claude Code — done!
```

That's it. Every tool result is now automatically compressed before entering Claude's context.

## The Problem

MCP tools return massive payloads that burn through Claude's context window:

| Source | Typical Size | With context-trash |
|---|---|---|
| Screenshot (base64) | ~250k tokens | ~500 tokens (OCR text) |
| DOM snapshot | 10-50k tokens | 3-15k tokens |
| API response (500 rows) | 50-100k tokens | 2-5k tokens |
| Large text/docs | 10-50k tokens | 3-20k tokens |

Claude's attention is O(n²). More tokens = slower responses, higher cost, earlier compaction. context-trash-mcp fixes this at the source.

## How It Works

context-trash-mcp installs as a `PostToolUse` hook in Claude Code. After every tool call, it intercepts the result and compresses it before Claude sees it.

```
Tool executes → Hook fires → context-trash compresses → Claude receives compressed result
```

Works with **all tools** — MCP servers (Playwright, databases, APIs) and built-in tools (Read, Bash, Grep). No need to configure each server individually.

### Compression Strategies

Each result is automatically routed to the best compressor:

| Content Type | Strategy | What it does | Reduction |
|---|---|---|---|
| Screenshots | **OCR** | Apple Vision / Tesseract extracts text from image | ~99% |
| DOM snapshots | **Cleanup** | Strips noise, builds ref mapping table | 50-70% |
| Large JSON | **Collapse** | Schema-aware array/object summarization | 60-90% |
| Large text | **Smart truncate** | BM25-ranked middle + optional Gemini | 60-90% |
| Small content | **Passthrough** | Below threshold — untouched | 0% |

### Smart Text Compression

For large text (>5k tokens), instead of dumb truncation:

```
≤5k tokens     → passthrough (no compression needed)
5k–23k tokens  → head(2k) + full middle + tail(1k)
23k–53k tokens → head(2k) + BM25-ranked middle(→20k) + tail(1k)
>53k tokens    → head(2k) + BM25(→50k) + Gemini(→20k) + tail(1k)
```

**How BM25 ranking works:** The middle section is split into ~512-token chunks. A synthetic relevance query is built from tool metadata:

```
read_file({path: "src/auth/login.ts"})  →  query: "auth login"
browser_navigate({url: "react.dev/..."}) → query: "react useState reference"
browser_snapshot() after navigate(url)   → inherits URL intent from session
```

Chunks are ranked by BM25 similarity to this query. Top chunks (by relevance, in original order) fill the token budget. This keeps the most relevant content, not just the beginning.

**Gemini 2.5 Flash-Lite** (optional, ~$0.01/call) compresses further for very large texts. Falls back to BM25-only if no API key or if Gemini is unavailable.

## Installation

### Option A: Hook mode (recommended)

Works with **all** tools automatically:

```bash
npm install -g context-trash-mcp
context-trash-mcp install
# Restart Claude Code (exit + claude)
```

This adds to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "context-trash-mcp --hook --verbose",
        "timeout": 15
      }]
    }]
  }
}
```

### Option B: Proxy mode (wrap specific MCP server)

```bash
# In ~/.claude.json, change MCP server command:
context-trash-mcp --wrap "npx @playwright/mcp@latest --cdp-endpoint http://localhost:9222" --verbose
```

Useful for testing or when you only want compression for specific servers.

### From source

```bash
git clone https://github.com/Chill-AI-Space/context-trash-mcp.git
cd context-trash-mcp
npm install --include=dev
npm run build
# Then: node dist/index.js install
```

### Uninstall

```bash
context-trash-mcp uninstall
# Restart Claude Code
```

## Configuration

### Config file

`~/.config/context-trash/config.json`:

```json
{
  "threshold": 500,
  "maxTextTokens": 2000,
  "activationBytes": 400000,
  "ocrEngine": "auto",
  "verbose": true,
  "dryRun": false,
  "geminiApiKey": "your-gemini-api-key"
}
```

| Option | Default | Description |
|---|---|---|
| `threshold` | 500 | Min tokens to trigger compression |
| `maxTextTokens` | 2000 | Target token budget per text block |
| `activationBytes` | 400000 | Min transcript size to activate (hook mode) |
| `ocrEngine` | `"auto"` | `auto` / `vision` (macOS) / `tesseract` |
| `verbose` | `false` | Log compression stats to stderr |
| `dryRun` | `false` | Log without modifying results |
| `geminiApiKey` | — | Gemini API key for smart compression of huge texts |
| `rules` | (see below) | Per-tool compression rules |

### Environment variables

```bash
export GEMINI_API_KEY="your-key"  # Alternative to config file
```

### CLI flags

```
--hook                   Run as PostToolUse hook (used by install)
--wrap "cmd args"        Wrap an MCP server (proxy mode)
--config <path>          Custom config file path
--verbose                Log compression stats to stderr
--dry-run                Log what would be compressed, don't modify
--ocr-engine <engine>    auto | vision | tesseract
--max-text-tokens <n>    Token budget for text blocks (default: 2000)
--threshold <n>          Min tokens to trigger compression (default: 500)
--gemini-api-key <key>   Gemini API key for smart compression
```

**Priority:** CLI flags > env vars > config file > defaults

### Per-tool rules

Override compression strategy for specific tools:

```json
{
  "rules": [
    { "toolName": "browser_snapshot", "strategy": "dom-cleanup" },
    { "toolName": "my_screenshot_tool", "strategy": "ocr" },
    { "toolNamePattern": "db_.*", "strategy": "json-collapse", "maxTokens": 5000 },
    { "toolNamePattern": ".*", "strategy": "auto" }
  ]
}
```

Strategies: `auto` | `ocr` | `dom-cleanup` | `json-collapse` | `truncate` | `passthrough`

Rules match tool names in order. First match wins. Default is `auto` (content-aware routing).

## Compressors in Detail

### OCR
- **macOS**: Compiles and caches a Swift binary using Apple Vision framework at `~/.cache/context-trash/vision-ocr-{hash}`
- **Other OS**: Falls back to Tesseract (`tesseract` must be in PATH)
- Quality check: if OCR returns <7 non-whitespace chars → keeps original image
- **Safety**: Only OCRs images when a file path exists in sibling text blocks (original is on disk). Generated images (base64-only) pass through untouched.

### DOM Cleanup
- Strips `[ref=e2]` markers from inline text
- Builds a compact ref mapping table at the bottom (Claude can still click elements)
- Removes `role="generic"` and `role="none"` noise
- Collapses empty generic nodes
- Deduplicates repeated navigation blocks
- Collapses multiple blank lines

### JSON Collapse
- Arrays >10 items → first 3 items + schema summary
- Detects homogeneous arrays (same keys) and shows shape: `{id, name, email}`
- Nesting beyond depth 5 → collapsed to key summary
- Strips null values, empty strings, empty arrays
- Falls through to truncate if content isn't valid JSON

### Smart Truncate
- Splits text into head (2k tokens), middle, tail (1k tokens)
- Chunks middle into ~512-token segments with 50-token overlap
- Structure-aware splitting: paragraph → line → sentence → word → hard split
- Ranks chunks with BM25 using synthetic query from tool context
- Selects top chunks (preserving original order) to fit 20k token budget
- Optional Gemini 2.5 Flash-Lite pass for middle sections >20k tokens
- Graceful fallback chain: Gemini fails → BM25-only, no query → preserve order

## Architecture

```
src/
├── index.ts              CLI entry point, arg parsing
├── proxy.ts              JSON-RPC stdio proxy (proxy mode)
├── hook.ts               PostToolUse hook handler (hook mode)
├── pipeline.ts           Content-aware routing + compression orchestration
├── classifier.ts         Content type detection (image/DOM/JSON/text)
├── config.ts             Config loading, rule matching
├── chunker.ts            Structure-aware text chunking
├── bm25.ts               BM25 keyword ranking (~100 lines, zero deps)
├── query-builder.ts      Synthetic relevance query from tool metadata
├── session.ts            Tool call history for intent inheritance
├── logger.ts             Stderr logging
└── compressors/
    ├── ocr.ts            Apple Vision / Tesseract OCR
    ├── dom-cleanup.ts    Accessibility tree cleanup + ref mapping
    ├── json-collapse.ts  Schema-aware JSON summarization
    ├── truncate.ts       Smart head + BM25 middle + tail pipeline
    └── gemini.ts         Gemini Flash-Lite API (raw fetch, no SDK)
```

## Design Decisions

**Zero runtime dependencies.** BM25, chunking, Gemini API — all built from scratch. Only TypeScript and Vitest as dev deps. Small, fast, auditable.

**Hook-first architecture.** PostToolUse hooks intercept ALL tool results universally. No need to wrap each MCP server individually. Proxy mode exists as an alternative.

**Content-aware routing.** Each content type gets a specialized compressor. DOM cleanup preserves clickability. JSON collapse preserves schema. OCR preserves semantic content.

**Synthetic relevance queries.** We infer intent from tool call metadata (URL navigated, file path read, grep pattern searched). Based on the [HyDE principle](https://arxiv.org/abs/2212.10496) — approximate queries work surprisingly well for ranking.

**Session intent inheritance.** `browser_snapshot()` after `browser_navigate(url)` inherits the URL's intent. Dramatically improves BM25 ranking for follow-up tool calls.

**Fail-safe everywhere.** Compressor fails → return original. Compression increases size >10% → return original. Gemini fails → BM25-only. No query signal → preserve original order. The tool never makes things worse.

**Context-aware activation (hook mode).** Checks transcript file size before compressing. Early in a session (context mostly empty), compression is skipped — full context is valuable. As context fills up, compression activates. Exception: screenshots are always compressed (250k tokens each).

## Testing

```bash
npm test           # 56 tests across 9 test files
npm run build      # compile TypeScript
```

## Troubleshooting

**Hook not firing?**
- Check `~/.claude/settings.json` has the PostToolUse hook
- Restart Claude Code after installing (`/exit` + `claude`)
- Run `context-trash-mcp --hook --verbose` manually with test input

**OCR not working?**
- macOS: Should work automatically (Apple Vision framework)
- Linux: Install `tesseract` (`apt install tesseract-ocr`)
- Check: `context-trash-mcp --hook --verbose` will log OCR errors to stderr

**Want to disable for specific tools?**
```json
{
  "rules": [
    { "toolName": "my_special_tool", "strategy": "passthrough" },
    { "toolNamePattern": ".*", "strategy": "auto" }
  ]
}
```

**Gemini compression not activating?**
- Only triggers for text >53k tokens (after head/tail split, middle >50k)
- Needs `GEMINI_API_KEY` env var or `geminiApiKey` in config
- Get a key at [Google AI Studio](https://aistudio.google.com/apikey) (free tier available)

## License

MIT

## Links

- [GitHub](https://github.com/Chill-AI-Space/context-trash-mcp)
- [npm](https://www.npmjs.com/package/context-trash-mcp)
- [Chill AI Space](https://github.com/Chill-AI-Space)
