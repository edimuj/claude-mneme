# Mneme Server Architecture

## Overview

Local daemon process that centralizes resource management for Claude Mneme across multiple concurrent Claude Code sessions.

## Design Decisions

### 1. Transport: HTTP on localhost

**Choice**: HTTP server bound to `127.0.0.1:PORT` (dynamic port assignment)

**Rationale**:
- **Cross-platform**: Works identically on Windows, macOS, Linux
- **Simple**: No platform-specific IPC (named pipes on Windows, Unix sockets on Linux)
- **Firewall-friendly**: Localhost-only, no external exposure
- **Debuggable**: Can use `curl` or browser for manual testing
- **Library support**: Every language has HTTP clients

**Pros**:
- Zero platform-specific code
- Easy to test and debug
- Well-understood semantics
- Can add auth headers if needed later

**Cons**:
- ~10-20% slower than Unix sockets (irrelevant for our use case)
- Slightly more overhead than IPC
- Port conflicts possible (mitigated by dynamic assignment)

**Port Assignment Strategy**:
```javascript
// Start server on random available port
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  // Write to PID file: { pid, port, startedAt }
});
```

### 2. In-Memory State Persistence

**Choice**: No persistence across restarts (ephemeral state only)

**Rationale**:
- **Simplicity**: Server is stateless storage layer, all data lives in files
- **Correctness**: Disk is source of truth, memory is just cache
- **Recovery**: If server crashes, next session starts fresh — no corruption risk
- **Testing**: Easier to reason about behavior

**What lives in memory**:
- Queued operations (acceptable to lose on crash)
- Cache of recently loaded summaries
- Deduplication window (last 1 minute of entries)
- Active session registry

**What lives on disk**:
- All logs, summaries, entities (unchanged from current design)
- PID file with server metadata

**Crash handling**:
- Hooks detect dead server, spawn new instance
- Queued operations lost, but next write succeeds
- Cache rebuilt on demand
- No data corruption since disk is authoritative

**Pros**:
- Simple implementation
- Fast startup
- No state corruption bugs
- Easy to kill/restart for debugging

**Cons**:
- Queued batches lost on crash (acceptable — hooks write to pending file as fallback)
- Cache cold after restart (rebuilds quickly)

**Future enhancement**: Optional WAL (write-ahead log) for queued operations if needed.

### 3. Monitoring & Metrics

**Choice**: Built-in metrics endpoint + structured logging

**Endpoints**:
```
GET /health
  Response: {
    ok: true,
    uptime: 12345,
    activeSessions: 3,
    queueDepth: {
      log: 15,
      summarize: 0,
      entity: 2
    },
    cache: {
      hitRate: 0.85,
      size: 12,
      maxSize: 100
    },
    stats: {
      requestsHandled: 1234,
      errorsTotal: 2,
      summarizationsCompleted: 5
    }
  }

GET /metrics
  Response: Prometheus-compatible text format
  (optional, for advanced users)

GET /debug/sessions
  Response: {
    sessions: [
      { id: "abc", cwd: "/path", registeredAt: "..." }
    ]
  }

GET /debug/queues
  Response: {
    log: { pending: 15, batchSize: 100, nextFlushIn: 523 },
    summarize: { running: true, queued: 0 },
    entity: { pending: 2 }
  }
```

**Structured logging**:
```javascript
// Log to stderr with JSON format
function log(level, event, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data
  };
  console.error(JSON.stringify(entry));
}

// Usage:
log('info', 'session-registered', { sessionId, cwd });
log('warn', 'summarize-throttled', { project, reason: 'cooldown' });
log('error', 'file-write-failed', { project, error: err.message });
```

**Log file**: `~/.claude-mneme/.server.log` (rotated daily, keep last 7 days)

**Diagnostic skill**:
```bash
/mneme:server-status
  -> Calls GET /health, displays formatted output
  -> Shows queue depths, cache stats, errors
  -> Suggests fixes for common issues
```

**Pros**:
- Easy debugging when things go wrong
- Can diagnose performance issues
- Users can self-serve via /status skill
- Foundation for future observability (Prometheus, etc.)

**Cons**:
- Slightly more code
- Log files need rotation

### 4. Multi-Machine Support (Future)

**Not in v1**, but architecture supports it:

**Current sync server**: Simple file push/pull (dumb storage)

**Future unified server**: Mneme Server + Sync Server combined
```
┌─────────────┐         ┌─────────────┐
│  Machine A  │────────▶│   Central   │◀────────┌─────────────┐
│  (laptop)   │  HTTPS  │   Server    │  HTTPS  │  Machine B  │
└─────────────┘         │             │         │  (desktop)  │
                        │ • Auth      │         └─────────────┘
                        │ • Storage   │
                        │ • Conflict  │
                        │   resolution│
                        └─────────────┘
```

**v1 → v2 migration path**:
1. v1: Local server only (this design)
2. v1.5: Add `server.remote.url` config option
   - If set, local server proxies to remote
   - If unset, local-only (current behavior)
3. v2: Deploy central server
   - Authentication (API keys)
   - Multi-tenant (project isolation)
   - Conflict resolution (CRDTs or last-write-wins)
   - Same HTTP API, just exposed over network

**Why this matters**:
- Work from multiple machines seamlessly
- Team collaboration (shared project memory)
- Backup/disaster recovery
- Replaces current sync server with smarter version

## Implementation Plan

**No backwards compatibility needed** — breaking changes acceptable.

### Phase 1: Core Server (Week 1)
- HTTP server with health endpoint
- Session registration/unregistration
- Auto-start/auto-stop lifecycle
- PID file management
- Basic logging

### Phase 2: Log Service (Week 1-2)
- `/log/append` endpoint
- Batching queue
- Deduplication
- File I/O with lock management
- **Replace** appendLogEntry entirely (no fallback)
- Update all hooks to use client

### Phase 3: Summarization Service (Week 2-3)
- `/summarize/*` endpoints
- Throttling/cooldown
- LLM call queue
- Summary caching
- **Remove** direct spawn code from utils.mjs

### Phase 4: Entity Service (Week 3)
- `/entity/*` endpoints
- Batched extraction
- Entity cache
- **Remove** direct extraction code

### Phase 5: Polish (Week 4)
- Metrics endpoint
- /status skill
- Error handling improvements
- Documentation

### Phase 6: Release (Week 4)
- Version bump to 3.0.0 (breaking change)
- Changelog noting server requirement
- Deploy

## File Structure

```
plugin/
├── server/
│   ├── mneme-server.mjs          # Main server process
│   ├── router.mjs                # HTTP routing
│   ├── services/
│   │   ├── log-service.mjs
│   │   ├── summarize-service.mjs
│   │   └── entity-service.mjs
│   ├── resources/
│   │   ├── queue-manager.mjs
│   │   ├── throttler.mjs
│   │   ├── deduplicator.mjs
│   │   └── cache.mjs
│   └── storage/
│       └── file-storage.mjs      # Disk I/O layer
├── client/
│   └── mneme-client.mjs          # Thin client for hooks
└── scripts/
    └── (existing hooks, updated to use client)
```

## Configuration

```json5
{
  "server": {
    "enabled": true,                    // Feature flag
    "host": "127.0.0.1",                // Never change (security)
    "inactivityTimeout": 900000,        // 15min (ms)

    "batching": {
      "log": {
        "maxSize": 100,                 // Entries per batch
        "maxWaitMs": 1000               // Max delay before flush
      },
      "entity": {
        "maxSize": 50,
        "maxWaitMs": 2000
      }
    },

    "throttling": {
      "summarize": {
        "maxConcurrent": 1,             // Only one LLM call at a time
        "cooldownMs": 30000             // 30s between runs per project
      }
    },

    "cache": {
      "maxSize": 100,                   // Max cached items
      "ttlMs": 300000                   // 5min TTL
    },

    "logging": {
      "enabled": true,
      "file": "~/.claude-mneme/.server.log",
      "level": "info",                  // debug | info | warn | error
      "rotation": {
        "maxFiles": 7,
        "maxAge": "7d"
      }
    }
  }
}
```

## API Reference

### Session Management

**Register Session**
```http
POST /session/register
Content-Type: application/json

{
  "sessionId": "abc-123",
  "cwd": "/home/user/project"
}

Response: { "ok": true }
```

**Unregister Session**
```http
POST /session/unregister
Content-Type: application/json

{ "sessionId": "abc-123" }

Response: { "ok": true }
```

### Log Operations

**Append Entry**
```http
POST /log/append
Content-Type: application/json

{
  "project": "/home/user/project",
  "entry": {
    "ts": "2026-02-12T20:00:00.000Z",
    "type": "prompt",
    "content": "Fix the bug in auth.js"
  }
}

Response: {
  "ok": true,
  "queued": true,
  "deduplicated": false
}
```

**Flush Pending**
```http
POST /log/flush
Content-Type: application/json

{ "project": "/home/user/project" }

Response: {
  "ok": true,
  "entriesFlushed": 42
}
```

### Summarization

**Trigger Summarization**
```http
POST /summarize/trigger
Content-Type: application/json

{
  "project": "/home/user/project",
  "force": false
}

Response: {
  "ok": true,
  "queued": true,
  "reason": null
}

// Or if throttled:
Response: {
  "ok": true,
  "queued": false,
  "reason": "cooldown",
  "retryAfterMs": 15000
}
```

**Get Summary**
```http
GET /summary/<project-hash>

Response: {
  "summary": { /* structured summary */ },
  "cached": true,
  "lastUpdated": "2026-02-12T19:55:00.000Z"
}
```

**Summarization Status**
```http
GET /summarize/status/<project-hash>

Response: {
  "running": true,
  "lastRun": "2026-02-12T19:50:00.000Z",
  "queuePosition": null
}
```

### Entity Operations

**Extract Entities**
```http
POST /entity/extract
Content-Type: application/json

{
  "project": "/home/user/project",
  "entries": [ /* log entries */ ]
}

Response: {
  "ok": true,
  "queued": true
}
```

**Lookup Entity**
```http
GET /entity/lookup/<project-hash>/<entity-name>

Response: {
  "entity": {
    "name": "auth.js",
    "type": "file",
    "contexts": [ /* contexts */ ]
  }
}

// Or if not found:
Response: { "entity": null }
```

### Health & Monitoring

**Health Check**
```http
GET /health

Response: {
  "ok": true,
  "uptime": 123456,
  "activeSessions": 3,
  "queueDepth": {
    "log": 15,
    "summarize": 0,
    "entity": 2
  },
  "cache": {
    "hitRate": 0.85,
    "size": 12,
    "maxSize": 100
  },
  "stats": {
    "requestsHandled": 1234,
    "errorsTotal": 2,
    "summarizationsCompleted": 5
  }
}
```

## Migration Strategy

### Hooks: Before (Current)
```javascript
// user-prompt-submit.mjs
appendLogEntry({ type: 'prompt', content: prompt }, cwd);
// -> Directly writes to file, spawns new Node process
```

### Hooks: After (Server-based)
```javascript
// user-prompt-submit.mjs
import { getClient } from './client/mneme-client.mjs';

const client = await getClient(); // Auto-starts server if needed
await client.appendLog(project, { type: 'prompt', content: prompt });
// -> HTTP POST, returns immediately
// -> Server batches and writes
```

**No fallback needed** — server is required for the plugin to function. If server fails to start, hooks exit with error (non-critical, session continues).

## Success Metrics

**Performance**:
- Session hangs: 0 (down from reported issues)
- Hook execution time: <50ms p99 (vs current ~200ms)
- Memory usage: <100MB total (vs current ~500MB+ with parallel sessions)
- CPU usage: <5% average

**Reliability**:
- Server uptime: >99.9% (auto-restart on crash)
- Data loss: 0 (fallback ensures writes succeed)
- Lock contention: 0 (single writer)

**Observability**:
- Error rate: <0.1% of operations
- Users can self-diagnose via /status
- Logs capture all failures

## Future Enhancements

1. **Metrics Export**: Prometheus endpoint for power users
2. **Remote Server**: Multi-machine sync (v2)
3. **Query API**: Search logs, filter by date/type
4. **Streaming**: WebSocket for real-time updates (UI integration)
5. **Compression**: Gzip log files older than 7 days
6. **Smart Scheduling**: Summarize during idle periods (detect typing pauses)

---

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
