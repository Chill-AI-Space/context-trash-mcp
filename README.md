# context-trash-mcp

Transparent MCP proxy that compresses bloated tool results before they enter Claude's context window. Zero runtime dependencies.

## The Problem

MCP tools (Playwright, database clients, API wrappers) return massive payloads that burn through Claude's context window:

- **Screenshots**: A single base64 screenshot = ~250k tokens
- **DOM snapshots**: Full accessibility trees = 10-50k tokens
- **API responses**: Large JSON arrays/objects = 5-100k tokens
- **Long text**: Documentation pages, logs = 10-50k tokens

Claude's attention is O(n^2). More tokens in context = slower responses, higher cost, earlier compaction.

## How It Works

context-trash-mcp sits between Claude and any MCP server, intercepting JSON-RPC responses and compressing them before Claude processes them.

```
Claude <---> context-trash-mcp <---> Playwright MCP
                   |
            compress results
```

### Compression Pipeline

Each tool result goes through content-aware routing:

| Content Type | Strategy | How |
|---|---|---|
| **Screenshots** | OCR | Apple Vision (macOS) or Tesseract extracts text, replaces base64 image. ~99% reduction |
| **DOM snapshots** | Cleanup | Strips `[ref=...]` inline, builds ref mapping table, removes `role="generic"`, deduplicates nav blocks. ~50-70% reduction |
| **Large JSON** | Collapse | Long arrays → first 3 items + schema. Strips nulls/empties. Collapses deep nesting. ~60-90% reduction |
| **Large text** | Smart truncate | Head + BM25-ranked middle + tail. Optional Gemini compression for huge texts. ~60-90% reduction |
| **Small content** | Passthrough | Under threshold — not touched |

### Smart Text Compression (new)

For large text (>5k tokens), instead of dumb head/tail truncation:

```
Text ≤5k tokens      → passthrough
Text 5k–23k tokens   → head(2k) + middle as-is + tail(1k)
Text 23k–53k tokens  → head(2k) + BM25 ranked middle(→20k) + tail(1k)
Text >53k tokens     → head(2k) + BM25(→50k) + Gemini(→20k) + tail(1k)
```

**BM25 ranking** selects the most relevant chunks from the middle section based on a synthetic relevance query built from:
- Tool name and arguments (e.g., `read_file({path: "src/auth/login.ts"})` → query about auth/login)
- Session history — if `browser_snapshot()` follows `browser_navigate({url})`, the snapshot inherits the URL's intent
- Falls back to preserving original order when no query signal is available

**Gemini 2.5 Flash-Lite** (optional) compresses the middle section intelligently when it's still >20k tokens after BM25 ranking. Costs ~$0.01 per compression. Only triggers for very large texts (>53k tokens).

### Image OCR Safety

Images are only OCR'd when there's a file path in the sibling text blocks (meaning the original file exists on disk). If the base64 image is the only copy (e.g., generated images), it passes through untouched.

## Installation

### Hook mode (recommended — works with ALL tools)

```bash
npx context-trash-mcp install
# Restart Claude Code
```

This adds a `PostToolUse` hook to `~/.claude/settings.json` that intercepts ALL tool results (MCP and built-in) and compresses them before Claude processes them. No need to modify any MCP server configs.

The hook receives `tool_name`, `tool_input`, and `tool_response` — so it has full context for BM25 relevance ranking and session intent tracking.

### Proxy mode (alternative — wrap a specific MCP server)

If you prefer to wrap a specific server instead of using hooks:

```bash
context-trash-mcp --wrap "npx @playwright/mcp@latest --cdp-endpoint http://localhost:9222" --verbose
```

This is useful for testing or when you want compression only for specific servers.

### From npm

```bash
npm install -g context-trash-mcp
```

### From source

```bash
git clone https://github.com/Chill-AI-Space/context-trash-mcp.git
cd context-trash-mcp
npm install --include=dev
npm run build
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
  "geminiApiKey": "your-key-here",
  "rules": [
    { "toolName": "browser_snapshot", "strategy": "dom-cleanup" },
    { "toolName": "puppeteer_snapshot", "strategy": "dom-cleanup" },
    { "toolNamePattern": ".*", "strategy": "auto" }
  ]
}
```

### CLI flags

```
--wrap "cmd args"        Wrap an MCP server (proxy mode)
--hook                   Run as Claude Code PostToolUse hook
--config <path>          Custom config file path
--verbose                Log compression stats to stderr
--dry-run                Log what would be compressed, don't modify
--ocr-engine <engine>    auto | vision | tesseract
--max-text-tokens <n>    Token threshold for text compression (default: 2000)
--threshold <n>          Min tokens to trigger compression (default: 500)
--gemini-api-key <key>   Gemini API key for smart compression
```

### Environment variables

- `GEMINI_API_KEY` — Gemini API key (alternative to CLI flag or config file)

### Priority

CLI flags > environment variables > config file > defaults

### Per-tool rules

Rules match tool names in order. First match wins.

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

Available strategies: `auto`, `ocr`, `dom-cleanup`, `json-collapse`, `truncate`, `passthrough`

## How Each Compressor Works

### OCR (`ocr`)
- **macOS**: Compiles and caches a Swift binary using Apple Vision framework (`~/.cache/context-trash/vision-ocr-{hash}`)
- **Other OS**: Falls back to Tesseract
- Quality check: if OCR returns <7 non-whitespace chars, keeps original image
- Hash-based cache invalidation for the Swift binary

### DOM Cleanup (`dom-cleanup`)
- Strips `[ref=...]` markers from inline text
- Builds a compact mapping table at the bottom for Claude to use when clicking
- Removes `role="generic"` and `role="none"` noise
- Collapses empty generic nodes
- Deduplicates repeated nav blocks
- Collapses multiple blank lines

### JSON Collapse (`json-collapse`)
- Arrays >10 items → first 3 items + schema summary (detects homogeneous structure)
- Nesting beyond depth 5 → collapsed to key summary
- Strips null values, empty strings, empty arrays
- Falls through to truncate if content isn't valid JSON

### Smart Truncate (`truncate`)
- Splits text into head (2k tokens), middle, tail (1k tokens)
- Chunks middle into ~512-token segments with 50-token overlap
- Ranks chunks with BM25 using synthetic query from tool context
- Selects top chunks (preserving original order) to fit token budget
- Optional Gemini 2.5 Flash-Lite pass for very large middle sections (>20k tokens after BM25)
- Falls back gracefully: no Gemini key → BM25 only, no query → preserve order

## Architecture

```
src/
  index.ts            CLI entry point, arg parsing
  proxy.ts            JSON-RPC stdio proxy with async processing queue
  hook.ts             Claude Code PostToolUse hook handler
  pipeline.ts         Content-aware routing and compression orchestration
  classifier.ts       Content type detection (image, DOM, JSON, text)
  config.ts           Config loading and rule matching
  chunker.ts          Structure-aware text chunking
  bm25.ts             BM25 ranking (zero dependencies, ~100 lines)
  query-builder.ts    Synthetic relevance query from tool metadata
  session.ts          Tool call history tracking for intent inheritance
  logger.ts           Stderr logging with verbose toggle
  compressors/
    ocr.ts            Apple Vision / Tesseract OCR
    dom-cleanup.ts    DOM accessibility tree cleanup
    json-collapse.ts  JSON array/object collapse
    truncate.ts       Smart head + BM25 middle + tail compression
    gemini.ts         Gemini Flash-Lite API (raw fetch, no SDK)
```

## Design Decisions

**Zero runtime dependencies.** Everything is built from scratch — BM25, chunking, Gemini API via fetch(). The only dependencies are TypeScript and Vitest (dev only). This keeps the package small and auditable.

**Transparent proxy.** No schema modifications, no injected fields, no changes to the MCP protocol. Claude and the wrapped server don't know the proxy exists.

**Content-aware routing.** Instead of one-size-fits-all compression, each content type gets a specialized compressor. DOM cleanup preserves clickability via ref mapping tables. JSON collapse preserves schema information. OCR preserves the semantic content of screenshots.

**Synthetic relevance queries.** Since we're a transparent proxy, we can't ask Claude what it's looking for. Instead, we infer intent from tool call metadata — the URL being navigated, the file path being read, the grep pattern being searched. This is based on the HyDE (Hypothetical Document Embeddings) principle: approximate queries work surprisingly well.

**Session intent inheritance.** `browser_snapshot()` after `browser_navigate(url)` inherits the URL's semantic intent. This dramatically improves BM25 ranking quality for follow-up tool calls.

**Fail-safe everywhere.** If any compressor fails, returns original content. If compression increases size >10%, returns original. If Gemini API fails, falls back to BM25-only. If no query signal, preserves original order.

## Testing

```bash
npm test              # run all tests
npm run build         # compile TypeScript
```

56 tests covering all compressors, BM25 ranking, chunking, query building, and pipeline integration.

## License

MIT
