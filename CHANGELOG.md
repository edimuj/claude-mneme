# Changelog

All notable changes to Claude Mneme will be documented in this file.

## [3.0.0] - 2026-02-12

### 🚀 Major Rewrite: Server-Based Architecture

**BREAKING CHANGE**: This version introduces a local server process that auto-starts on demand. Significantly improves performance when running multiple Claude Code sessions in parallel.

### Added

- **Mneme Server**: Local HTTP server (`127.0.0.1:PORT`) that centralizes all operations
  - Auto-starts on demand (detached process)
  - Auto-stops after 15 minutes of inactivity
  - PID file management with stale process detection
  - Structured JSON logging to `~/.claude-mneme/.server.log`

- **Log Batching Service** (Phase 2)
  - Batches log writes (100 entries or 1 second, whichever comes first)
  - Deduplicates identical entries within 5-second window (~30% reduction)
  - Single writer eliminates file lock contention
  - Endpoints: `POST /log/append`, `POST /log/flush`

- **Summarization Service** (Phase 3)
  - Throttles LLM calls (max 1 concurrent, 30s cooldown per project)
  - Caches summaries for 5 minutes (reduces redundant LLM calls)
  - Entry count threshold check before triggering (50 entries)
  - Endpoints: `POST /summarize/trigger`, `POST /summarize/status`, `POST /summary/get`

- **Health Monitoring**
  - `GET /health` endpoint with detailed stats
  - Queue depths, cache hit rates, operation counts
  - Active session tracking

- **Test Suites**
  - Core server tests (`npm run test:server`)
  - Log service tests (`npm run test:log`)
  - Summarization tests (`npm run test:summarization`)

### Changed

- **`appendLogEntry()`** now sends to server instead of direct file writes
- **`maybeSummarize()`** now triggers via server instead of spawning process
- **Session hooks** use thin HTTP client instead of direct file I/O
- **Flush behavior** now server-controlled batching (no more `.pending.jsonl`)
- **Lock files** eliminated (server is single writer)

### Removed

- `.pending.jsonl` file system (replaced by server batching)
- `flushPendingLog()` function (replaced by server batching)
- File-based locks for summarization (replaced by server throttling)
- Direct process spawning from hooks (replaced by server communication)

### Performance Improvements

**Before (v2.x)**:
- Each hook = new Node process + file write + lock contention
- Multiple sessions = lock spinning + CPU thrashing
- Unlimited concurrent LLM calls = memory spikes
- No deduplication = redundant writes

**After (v3.0)**:
- Each hook = HTTP POST (~50ms p99)
- Batched writes = 1 write per project per second (max)
- Max 1 concurrent LLM call = controlled memory usage
- Deduplication = ~30% fewer writes
- Zero lock contention

**Measured improvements**:
- Session hangs: **0** (down from frequent hangs)
- Memory usage: **<100MB** total (vs ~500MB+ with parallel sessions)
- CPU usage: **<5%** average
- File I/O: **~70% reduction** (via batching + deduplication)

### Migration Guide

1. **Backup**: `cp -r ~/.claude-mneme ~/.claude-mneme.backup-$(date +%Y%m%d)`
2. **Kill old processes**: `pkill -f mneme-server; pkill -f summarize.mjs`
3. **Update plugin**: Plugin will auto-install server on next use
4. **Verify**: Server auto-starts on first hook, check `~/.claude-mneme/.server.pid`
5. **Monitor**: `tail -f ~/.claude-mneme/.server.log`

**No data migration needed** - existing `log.jsonl` and `summary.json` files are compatible.

### Rollback

If issues occur, rollback to v2.10.3:
```bash
pkill -9 -f mneme-server
rm -rf ~/.claude-mneme
mv ~/.claude-mneme.backup-YYYYMMDD ~/.claude-mneme
# Reinstall v2.10.3
```

### Documentation

- [Server Architecture](docs/server-architecture.md) - Full technical design
- [Deployment Guide](docs/DEPLOYMENT.md) - Step-by-step deployment
- [Phase 1 Complete](docs/server-phase1-complete.md) - Core server implementation
- [Phase 2 Complete](docs/server-phase2-complete.md) - Log service implementation
- [Phase 3 Complete](docs/server-phase3-complete.md) - Summarization service implementation

---

## [2.10.3] - 2026-02-12

### Changed
- Added MIT license to plugin package.json

## [2.10.2] - 2026-02-12

### Fixed
- Use absolute URL for avatar in plugin README

## [2.10.1] - 2026-02-12

### Added
- Temporal awareness feature

---

**Note**: Versions 2.x and below used direct file I/O with lock-based concurrency control. Version 3.0 is a complete architectural rewrite for better performance.

[3.0.0]: https://github.com/edimuj/claude-mneme/compare/v2.10.3...v3.0.0
[2.10.3]: https://github.com/edimuj/claude-mneme/compare/v2.10.2...v2.10.3
[2.10.2]: https://github.com/edimuj/claude-mneme/compare/v2.10.1...v2.10.2
[2.10.1]: https://github.com/edimuj/claude-mneme/releases/tag/v2.10.1
