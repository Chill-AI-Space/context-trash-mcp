# compress-on-input

PostToolUse hook for Claude Code that compresses bloated tool results before they enter the context window. Zero runtime dependencies.

## Commands

```bash
npm run build          # compile TypeScript
npm test               # vitest (58 tests, 3 known failures in dom-cleanup)
npm link               # install globally from source (symlink)
```

### CLI

```bash
compress-on-input install      # add hook to ~/.claude/settings.json
compress-on-input uninstall    # remove hook
compress-on-input check        # run 17 self-diagnostic checks (aliases: doctor, test)
compress-on-input --hook       # run as PostToolUse hook (reads JSON from stdin)
compress-on-input --wrap "cmd" # proxy mode — wrap an MCP server
compress-on-input --help       # full usage
```

## Architecture

- `src/index.ts` — CLI entry point, arg parsing
- `src/hook.ts` — PostToolUse hook handler (stdin JSON → stdout JSON)
- `src/pipeline.ts` — content-aware routing + compression orchestration
- `src/classifier.ts` — content type detection (image/DOM/JSON/text)
- `src/config.ts` — config loading from `~/.config/compress-on-input/config.json`
- `src/doctor.ts` — self-diagnostics (`check` command)
- `src/install.ts` — hook install/uninstall in settings.json
- `src/compressors/ocr.ts` — Apple Vision (macOS) / Tesseract OCR
- `src/compressors/dom-cleanup.ts` — accessibility tree cleanup
- `src/compressors/json-collapse.ts` — schema-aware JSON summarization
- `src/compressors/truncate.ts` — BM25-ranked smart truncation
- `src/compressors/gemini.ts` — Gemini Flash-Lite API (optional)
- `src/bm25.ts` — BM25 keyword ranking
- `src/chunker.ts` — structure-aware text chunking
- `src/query-builder.ts` — synthetic relevance query from tool metadata
- `src/session.ts` — tool call history for intent inheritance
- `src/proxy.ts` — JSON-RPC stdio proxy (proxy mode)

## Key Design Rules

- **Built-in tools are skipped** in hook mode (`hook.ts:144`) — they don't support `updatedMCPToolOutput`. Only MCP tools (`mcp__*`) get compressed.
- **Images without file path are preserved** — never OCR an image that has no file on disk (could be generated content). Known screenshot tools (Playwright) are OCR'd regardless.
- **Fail-safe everywhere** — compressor fails → return original. Compression increases size → return original.
- **Text compression threshold is 100k tokens** by default — small/medium text passes through untouched.
- **JSON collapse threshold is 500 tokens** — lower because it's lossless.

## Logs

- Debug log: `~/.local/share/compress-on-input/debug.log`
- Events log: `~/.local/share/compress-on-input/events.jsonl`
- Hook config: `~/.claude/settings.json` → `hooks.PostToolUse`
- User config: `~/.config/compress-on-input/config.json`

## Testing changes

After modifying source, always:
1. `npm run build`
2. `compress-on-input check` — verifies hook, OCR, compression, performance
3. `npm test` — unit tests (3 known failures in dom-cleanup are pre-existing)
