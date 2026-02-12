# Mneme Server Deployment Guide

## Overview

Version 3.0.0 introduces a server-based architecture that eliminates performance issues when running multiple Claude Code sessions in parallel.

## Breaking Changes

**This is a breaking change.** The plugin now requires a local server process that auto-starts on demand.

### What Changed

1. **Log writes** - Now batched and deduplicated through server
2. **Summarization** - Now throttled (max 1 concurrent LLM call)
3. **No more lock contention** - Single writer eliminates file locking issues

### Migration Notes

- `.pending.jsonl` files no longer used (can be safely deleted)
- `.lock` files no longer created for summarization
- Existing `log.jsonl` and `summary.json` files compatible (no migration needed)

## Pre-Deployment Checklist

### 1. Backup Current State

```bash
# Backup your memory directory
cp -r ~/.claude-mneme ~/.claude-mneme.backup-$(date +%Y%m%d)
```

### 2. Kill Any Running Old Processes

```bash
# Kill any old mneme-related processes
pkill -f mneme-server
pkill -f summarize.mjs
```

### 3. Verify Node.js Version

```bash
node --version  # Should be v18+ (tested on v24)
```

## Deployment Steps

### 1. Install/Update Plugin

```bash
cd /home/edimuj/projects/claude-mneme

# If developing locally, link it
cd plugin
npm link
cd ~/.claude/plugins
ln -sf /home/edimuj/projects/claude-mneme/plugin claude-mneme

# Or install from npm (when published)
# claude plugin install claude-mneme
```

### 2. Verify Server Auto-Start

```bash
# Start a new Claude Code session
# The server should auto-start on first hook execution

# Check if server is running
cat ~/.claude-mneme/.server.pid

# Check server logs
tail -f ~/.claude-mneme/.server.log
```

### 3. Test Basic Functionality

Open a Claude Code session and run:

```bash
# This should trigger log writes through the server
echo "test" > test.txt

# Check server is handling requests
cat ~/.claude-mneme/.server.log | grep log-append

# Server should show batched writes
cat ~/.claude-mneme/.server.log | grep log-batch-flushed
```

### 4. Test Parallel Sessions

Open 3+ Claude Code sessions simultaneously and work in parallel:

```bash
# In each session, do some work that triggers hooks
# (file edits, git commits, etc.)

# Monitor server load
ps aux | grep mneme-server

# Check server health
curl -s http://127.0.0.1:$(jq -r .port ~/.claude-mneme/.server.pid)/health | jq
```

**Expected**: No hangs, no lock contention, server shows batched operations.

## Monitoring

### Server Health Check

```bash
#!/bin/bash
# Check server status

if [ -f ~/.claude-mneme/.server.pid ]; then
  PID=$(jq -r .pid ~/.claude-mneme/.server.pid)
  PORT=$(jq -r .port ~/.claude-mneme/.server.pid)

  echo "Server running: PID $PID, Port $PORT"

  # Health check
  curl -s http://127.0.0.1:$PORT/health | jq '
    {
      uptime: .uptime,
      sessions: .activeSessions,
      "log queue": .queueDepth.log,
      "cache hit rate": .cache.hitRate,
      "log stats": .stats.log,
      "summarization stats": .stats.summarization
    }
  '
else
  echo "Server not running"
fi
```

### Server Logs

```bash
# Watch server activity
tail -f ~/.claude-mneme/.server.log | jq -r '[.ts, .level, .event, .error // ""] | @tsv'

# Check for errors
grep '"level":"error"' ~/.claude-mneme/.server.log | jq

# Monitor batch performance
grep log-batch-flushed ~/.claude-mneme/.server.log | jq -r '[.ts, .totalEntries, .projects] | @tsv'
```

### Performance Metrics

```bash
# Monitor memory usage
ps aux | grep mneme-server | awk '{print $6/1024 "MB"}'

# Monitor CPU usage
top -p $(jq -r .pid ~/.claude-mneme/.server.pid) -n 1 | tail -2
```

## Troubleshooting

### Server Won't Start

```bash
# Check logs for startup errors
cat ~/.claude-mneme/.server.log | grep server-started -A 5

# Try starting manually
node /home/edimuj/projects/claude-mneme/plugin/server/mneme-server.mjs

# Check port conflicts
lsof -i :$(jq -r .port ~/.claude-mneme/.server.pid 2>/dev/null || echo 0)
```

### Hooks Failing

```bash
# Check Claude Code hook logs
# (Usually in session output or ~/.claude/logs/)

# Verify client can connect
node -e "
import('./plugin/client/mneme-client.mjs').then(({getClient}) =>
  getClient().then(c => c.health()).then(h => console.log('OK:', h))
).catch(e => console.error('ERROR:', e.message))
"
```

### Server Hangs or High CPU

```bash
# Check what it's doing
strace -p $(jq -r .pid ~/.claude-mneme/.server.pid)

# Check queue depths
curl -s http://127.0.0.1:$(jq -r .port ~/.claude-mneme/.server.pid)/health | jq .queueDepth

# Restart server (safe - it flushes on shutdown)
kill -TERM $(jq -r .pid ~/.claude-mneme/.server.pid)
# Will auto-restart on next hook
```

### Performance Still Poor

```bash
# Check if old processes are still running
ps aux | grep -E "summarize|pending|flush"

# Check for excessive logging
wc -l ~/.claude-mneme/*/log.jsonl

# Check deduplication effectiveness
curl -s http://127.0.0.1:$(jq -r .port ~/.claude-mneme/.server.pid)/health | \
  jq '.stats.log | "Deduplicated: \(.entriesDeduplicated)/\(.entriesReceived) (\((.entriesDeduplicated / .entriesReceived * 100) | floor)%)"'
```

## Rollback Plan

If deployment fails, rollback to previous version:

```bash
# 1. Kill server
pkill -9 -f mneme-server

# 2. Restore backup
rm -rf ~/.claude-mneme
mv ~/.claude-mneme.backup-YYYYMMDD ~/.claude-mneme

# 3. Reinstall old version
# (git checkout previous tag or npm install previous version)

# 4. Restart Claude Code sessions
```

## Success Criteria

After deployment, verify:

- ✓ Server auto-starts on first hook
- ✓ Multiple parallel sessions work without hangs
- ✓ Log batching reduces file I/O (check batch stats)
- ✓ Summarization throttled (max 1 concurrent)
- ✓ Memory usage stable (<100MB for server)
- ✓ CPU usage low (<5% average)
- ✓ No lock files created (`.lock`, `.pending.jsonl`)

## Post-Deployment

### Cleanup Old Files

After confirming stability (1-2 days):

```bash
# Remove old pending files (no longer used)
find ~/.claude-mneme -name "*.pending.jsonl" -delete

# Remove old lock files
find ~/.claude-mneme -name "*.lock" -delete

# Remove backup (if everything works)
rm -rf ~/.claude-mneme.backup-*
```

### Tune Configuration

Edit `~/.claude-mneme/config.json`:

```json
{
  "batching": {
    "log": {
      "maxSize": 100,     // Entries per batch (increase if high-volume)
      "maxWaitMs": 1000   // Max delay before flush (decrease for lower latency)
    }
  },
  "throttling": {
    "summarize": {
      "maxConcurrent": 1,   // Keep at 1 (prevents LLM spam)
      "cooldownMs": 30000   // 30s between summarizations per project
    }
  },
  "cache": {
    "maxSize": 100,        // Max cached summaries
    "ttlMs": 300000        // 5min TTL
  },
  "summarization": {
    "entryThreshold": 50   // Entries before triggering summarization
  }
}
```

---

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
