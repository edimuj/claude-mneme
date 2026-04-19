# Claude Mneme — Project CLAUDE.md

## Repo Layout

```
plugin/                    Claude Code plugin (this is the product)
  .claude-plugin/          plugin.json manifest
  hooks/                   hooks.json (registered lifecycle hooks)
  scripts/                 Hook entry points + skill scripts
  server/                  Plugin Service (local background process)
  client/                  mneme-client.mjs (hooks → Plugin Service)
  lib/                     Shared modules (entities, memory-retriever, log-metadata)
  skills/                  Skill definitions (SKILL.md per skill)
  dashboard/               Web dashboard (server.mjs + dashboard-ctl.mjs)
  CLAUDE.md                Detailed internal reference (gitignored, ~215 lines)
server/                    Sync Server (optional, remote, separate from Plugin Service)
assets/                    Images for README
docs/                      Additional docs
```

No root package.json — the npm project lives in `plugin/`.

## Quick Dev Commands

```bash
cd plugin
npm test                                    # utils.test.mjs (195 tests)
node --test lib/entities.test.mjs           # entities (87 tests)
node --test lib/error-log.test.mjs          # error-log (10 tests)
node --test lib/text.test.mjs              # text processing (28 tests)
node --test lib/summary-format.test.mjs    # summary formatting (33 tests)
node --test lib/log-metadata.test.mjs       # log-metadata (22 tests)
node --test lib/memory-retriever.test.mjs   # retriever (26 tests)
node --test scripts/session-start.test.mjs  # session-start (17 tests)
node --test scripts/session-stop.test.mjs   # session-stop (2 tests)
node --test scripts/pre-compact.test.mjs    # pre-compact extractors (37 tests)
node --test scripts/summarize.test.mjs      # summarize applyUpdates (19 tests)
node --test client/mneme-client.test.mjs    # HTTP client (20 tests)
node --test server/mneme-server.test.mjs    # server routing (23 tests)
node --test server/capture-service.test.mjs # capture (31 tests)
node --test server/batch-queue.test.mjs     # batch queue
node --test server/entity-service.test.mjs  # entity service
node --test server/summarization-service.test.mjs
node --test server/log-service.unit.test.mjs
```

Run all: `cd plugin && npm test && node --test lib/*.test.mjs scripts/*.test.mjs client/*.test.mjs server/*.test.mjs`

## Architecture

Two independent servers — don't mix them up:
- **Plugin Service** (`plugin/server/mneme-server.mjs`) — local, hooks talk to it via HTTP. Owns log writes, dedup, entities, capture, summarization.
- **Sync Server** (`server/mneme-server.mjs`) — remote, optional, syncs memory files across machines.

Hook scripts are thin forwarders to Plugin Service. If server is down, some hooks fall back to direct file I/O via utils.mjs.

## Key Files (read plugin/CLAUDE.md for full API reference)

| File | Role | Size |
|------|------|------|
| `scripts/utils.mjs` | ~1400 lines, core utilities (paths, config, locking, caching, scoring). Use `tl-symbols`/`tl-snippet`, never read whole. |
| `scripts/session-start.mjs` | Context injection at session start. Main entry: `main()` |
| `scripts/pre-compact.mjs` | PreCompact handler. Has LLM calls (keyPoints, forceSummarize) gated by cooldown |
| `scripts/summarize.mjs` | Standalone script spawned for summarization. Uses Agent SDK `query()` |
| `server/capture-service.mjs` | Server-side response capture, handoff extraction |
| `lib/error-log.mjs` | Error logging, rotation, querying (extracted from utils.mjs) |
| `lib/text.mjs` | Markdown stripping, sentence splitting, extractive summarization |
| `lib/summary-format.mjs` | Entry formatting, summary rendering, decision line formatting |
| `lib/memory-retriever.mjs` | Context-aware memory retrieval (signal scoring) |
| `lib/entities.mjs` | Entity extraction, scoring, pruning |
| `lib/log-metadata.mjs` | Fast entry counting via sidecar metadata |

## Session Opt-Out

All hooks check `isSessionDisabled(cwd)` from utils.mjs:
1. `MNEME_DISABLED=1` env var — fast exit, no imports needed
2. `config.excludePatterns` (default: `[".ao-worktrees-"]`) — cwd substring match

Stdin-based hooks also have a fast-path `process.env.MNEME_DISABLED` check before setting up stdin handlers.

## Summarization Gotchas

- Two lock files: `.lock` (prevents concurrent runs), `.wlock` (prevents log append during truncation)
- Past deadlock bug: maybeSummarize held .lock then spawned summarize.mjs which also tried .lock. Fixed.
- `summarize.mjs` detects server-spawned vs direct invocation by checking if cwd starts with MEMORY_BASE
- Pre-compact LLM work has a 5-min per-project cooldown (`.pre-compact-ts` file)
- keyPoints extraction is opt-in (`preCompact.extraction.categories.keyPoints: true`)

## Releasing

Three files must stay in sync:
- `plugin/.claude-plugin/plugin.json` → `version`
- `plugin/package.json` → `version`
- `README.md` → badge URL version string

Steps: bump all three → commit "chore: release X.Y.Z" → push.

Run `claude-rig update-plugins` after push to propagate to all rigs.

## Storage

All data under `~/.claude-mneme/`. Per-project dirs named by absolute path with `/` → `-`.
Config: `~/.claude-mneme/config.json`. Errors: `~/.claude-mneme/errors.log`.

## Dependency

Single runtime dep: `@anthropic-ai/claude-agent-sdk` (for `query()` in summarize.mjs and pre-compact.mjs).
Everything else is Node built-ins. Node 18+.
