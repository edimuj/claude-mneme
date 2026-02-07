# Claude Mneme — Configuration Reference

Full configuration options for `~/.claude-mneme/config.json`. See the [README](../README.md) for an overview of the plugin.

## Structured Summary Format

The summary is stored as JSON for efficient incremental updates:

```json
{
  "projectContext": "What this project is",
  "keyDecisions": [
    {
      "date": "2025-02-04",
      "decision": "...",
      "reason": "..."
    }
  ],
  "currentState": [
    {
      "topic": "Feature",
      "status": "Implemented",
      "updatedAt": "2025-02-04T15:00:00Z"
    }
  ],
  "recentWork": [
    {
      "date": "2025-02-04",
      "summary": "What was done"
    }
  ],
  "lastUpdated": "2025-02-04T15:00:00Z"
}
```

### Migrating Existing Summaries

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/summarize.mjs" . --migrate
```

Migration also happens automatically on the next summarization cycle.

## Response Summarization

Controls how assistant responses are processed before storing in the activity log.

### Modes

| Mode          | Description                                                      |
|---------------|------------------------------------------------------------------|
| `"none"`      | **Default.** No summarization — just truncate at `maxResponseLength`. Preserves reasoning and trade-off discussions. |
| `"extractive"`| Sentence scoring using action words, reasoning words, and entity references. Keeps top N sentences. |
| `"llm"`       | *(Reserved)* LLM-based structured summarization for highest quality. |

### Configuration

```json
{
  "responseSummarization": "none",
  "maxResponseLength": 1000,
  "maxSummarySentences": 6,
  "reasoningWords": ["because", "instead", "decided", "can't", "avoid", "prefer", "constraint"]
}
```

| Option                   | Default        | Description                                             |
|--------------------------|----------------|---------------------------------------------------------|
| `responseSummarization`  | `"none"`       | Summarization mode: `"none"`, `"extractive"`, `"llm"`   |
| `maxResponseLength`      | `1000`         | Hard cap on stored response length (all modes)          |
| `maxSummarySentences`    | `6`            | Max sentences kept in extractive mode                   |
| `actionWords`            | *(see source)* | Words scored in extractive mode (action/completion)     |
| `reasoningWords`         | *(see source)* | Words scored in extractive mode (decisions/trade-offs)  |

**Migration:** If your config has the legacy `summarizeResponses: true`, it maps to `"extractive"`. `false` maps to `"none"`.

## Compaction Hooks

The plugin captures context before compaction and restores it afterward.

### PreCompact → PostCompact Flow

```
1. PreCompact fires (before compaction)
   ├── Flush pending log entries
   ├── Extract context (decisions, files, errors, todos, key points)
   ├── Save to extracted-context.json
   └── Force summarization

2. Claude Code compacts conversation

3. PostCompact fires (SessionStart with "compact" matcher)
   └── Inject extracted context back into conversation
```

### PreCompact Configuration

```json
{
  "preCompact": {
    "enabled": true,
    "triggers": ["auto", "manual"],
    "flushPending": true,
    "forceSummarize": true,
    "extractContext": true,
    "saveSnapshot": false,
    "extraction": {
      "enabled": true,
      "maxItems": 10,
      "categories": {
        "decisions": true,
        "files": true,
        "errors": true,
        "todos": true,
        "keyPoints": true
      }
    }
  }
}
```

| Option                    | Default              | Description                                   |
|---------------------------|----------------------|-----------------------------------------------|
| `enabled`                 | `true`               | Enable/disable the PreCompact hook entirely   |
| `triggers`                | `["auto", "manual"]` | Which triggers to respond to                  |
| `flushPending`            | `true`               | Flush pending log entries before processing   |
| `forceSummarize`          | `true`               | Force immediate summarization                 |
| `extractContext`          | `true`               | Extract context from transcript               |
| `saveSnapshot`            | `false`              | Save full transcript to snapshots/ directory  |
| `extraction.maxItems`     | `10`                 | Max items per extraction category             |
| `extraction.categories.*` | `true`               | Enable/disable specific extraction categories |

**Extraction categories:** `decisions`, `files`, `errors`, `todos`, `keyPoints` (AI-extracted via Haiku)

### PostCompact Configuration

```json
{
  "postCompact": {
    "enabled": true,
    "maxAgeMinutes": 5,
    "maxFiles": 10,
    "categories": {
      "keyPoints": true,
      "decisions": true,
      "files": true,
      "errors": true,
      "todos": true
    }
  }
}
```

| Option          | Default | Description                                         |
|-----------------|---------|-----------------------------------------------------|
| `enabled`       | `true`  | Enable/disable context injection after compaction   |
| `maxAgeMinutes` | `5`     | Only inject if extraction happened within this time |
| `maxFiles`      | `10`    | Maximum file paths to include in injection          |
| `categories.*`  | `true`  | Enable/disable specific categories in injection     |

## Relevance-Based Injection

Scores entries by relevance instead of pure recency.

**Scoring factors:**

1. **Recency** (40%) - Exponential decay based on entry age
2. **File relevance** (35%) - Entries mentioning files in current project score higher
3. **Type priority** (25%) - commits > tasks > agents > prompts > responses

### Configuration

```json
{
  "relevanceScoring": {
    "enabled": true,
    "maxEntries": 10,
    "weights": {
      "recency": 0.4,
      "fileRelevance": 0.35,
      "typePriority": 0.25
    },
    "typePriorities": {
      "commit": 1.0,
      "task": 0.9,
      "agent": 0.8,
      "prompt": 0.5,
      "response": 0.3,
      "compact": 0.4
    },
    "recencyHalfLifeHours": 24
  }
}
```

| Option                 | Default | Description                                      |
|------------------------|---------|--------------------------------------------------|
| `enabled`              | `true`  | Enable/disable relevance scoring                 |
| `maxEntries`           | `10`    | Max entries to inject after scoring              |
| `weights.*`            | varies  | Weight for each scoring factor (should sum to 1) |
| `typePriorities.*`     | varies  | Priority score (0-1) for each entry type         |
| `recencyHalfLifeHours` | `24`    | Hours until recency score drops to 50%           |

## Entity Extraction

Extracts and indexes key entities from log entries for smarter context and relevance scoring.

### What Gets Extracted

| Category    | Examples                       | Pattern                    |
|-------------|--------------------------------|----------------------------|
| `files`     | `src/auth.ts`, `utils.mjs`     | File paths with extensions |
| `functions` | `handleLogin`, `fetchUser`     | Function/method names      |
| `errors`    | `TypeError: Cannot read...`    | Error messages and types   |
| `packages`  | `express`, `@anthropic-ai/sdk` | npm/pip package names      |

### Configuration

```json
{
  "entityExtraction": {
    "enabled": true,
    "maxContextsPerEntity": 5,
    "maxAgeDays": 30,
    "categories": {
      "files": true,
      "functions": true,
      "errors": true,
      "packages": true
    },
    "fileExtensions": ["js", "ts", "jsx", "tsx", "mjs", "py", "go", "rs", "java", "..."],
    "minEntityLength": 2,
    "useInRelevanceScoring": true
  }
}
```

| Option                  | Default | Description                               |
|-------------------------|---------|-------------------------------------------|
| `enabled`               | `true`  | Enable/disable entity extraction          |
| `maxContextsPerEntity`  | `5`     | Max recent contexts to keep per entity    |
| `maxAgeDays`            | `30`    | Prune entities not seen in N days (0=off) |
| `categories.*`          | `true`  | Enable/disable specific entity categories |
| `fileExtensions`        | [...]   | Only index files with these extensions    |
| `minEntityLength`       | `2`     | Minimum entity name length to index       |
| `useInRelevanceScoring` | `true`  | Use entity "hotness" in relevance scoring |

### Storage

Entities stored in `~/.claude-mneme/projects/<project>/entities.json`:

```json
{
  "files": {
    "src/auth.ts": {
      "mentions": 12,
      "lastSeen": "2025-02-04T15:00:00Z",
      "contexts": [{ "ts": "...", "type": "commit", "summary": "Added JWT validation" }]
    }
  }
}
```

## Hierarchical Context Injection

Context is injected at session start with priority-based ordering:

| Priority   | Sections                                                              | Behavior                    |
|------------|-----------------------------------------------------------------------|-----------------------------|
| **TOP**    | Last Session (handoff)                                                | If <48h old                 |
| **HIGH**   | Project Context, Key Decisions, Current State, Remembered             | Always injected             |
| **MEDIUM** | Recent Work, Git Changes, Active Entities                             | Injected if relevant/recent |
| **LOW**    | Recent Activity (log entries)                                         | Limited to last 3-4 entries |

### Configuration

```json
{
  "contextInjection": {
    "enabled": true,
    "sections": {
      "lastSession": {
        "enabled": true
      },
      "projectContext": {
        "enabled": true,
        "priority": "high"
      },
      "keyDecisions": {
        "enabled": true,
        "priority": "high",
        "maxItems": 10
      },
      "currentState": {
        "enabled": true,
        "priority": "high",
        "maxItems": 10,
        "staleAfterDays": 3
      },
      "remembered": {
        "enabled": true,
        "priority": "high"
      },
      "recentWork": {
        "enabled": true,
        "priority": "medium",
        "maxItems": 5,
        "maxAgeDays": 7
      },
      "gitChanges": {
        "enabled": true,
        "priority": "medium"
      },
      "activeEntities": {
        "enabled": true,
        "priority": "medium",
        "maxFiles": 5,
        "maxFunctions": 5
      },
      "recentEntries": {
        "enabled": true,
        "priority": "low",
        "maxItems": 4
      }
    },
    "budgetMode": "adaptive"
  }
}
```

| Option                            | Default    | Description                                           |
|-----------------------------------|------------|-------------------------------------------------------|
| `sections.lastSession.enabled`    | `true`     | Show handoff from previous session                    |
| `sections.currentState.staleAfterDays` | `3`   | Hide completed items after N days (0=disabled)        |
| `sections.*.enabled`              | `true`     | Enable/disable specific section                       |
| `sections.*.maxItems`             | varies     | Max items to show in section                          |
| `sections.recentWork.maxAgeDays`  | `7`        | Only show work from last N days                       |
| `sections.recentEntries.maxItems` | `4`        | Reduced from 10 to minimize noise                     |
| `budgetMode`                      | `adaptive` | Future: auto-adjust based on context window           |

## Semantic Deduplication

Groups related entries by timestamp proximity and keeps only the highest-signal entry.

### Signal Priority (highest to lowest)

| Type       | Priority | Rationale                 |
|------------|----------|---------------------------|
| `commit`   | 100      | Represents completed work |
| `task`     | 80       | Shows what was worked on  |
| `agent`    | 70       | Agent's summary of work   |
| `prompt`   | 40       | The original request      |
| `response` | 30       | Assistant's response      |
| `compact`  | 20       | Compaction marker         |

### Configuration

```json
{
  "deduplication": {
    "enabled": true,
    "timeWindowMinutes": 5,
    "typePriority": {
      "commit": 100,
      "task": 80,
      "agent": 70,
      "prompt": 40,
      "response": 30,
      "compact": 20
    },
    "mergeContext": true
  }
}
```

| Option              | Default | Description                      |
|---------------------|---------|----------------------------------|
| `enabled`           | `true`  | Enable/disable deduplication     |
| `timeWindowMinutes` | `5`     | Group entries within this window |
| `typePriority.*`    | varies  | Priority score per entry type    |
| `mergeContext`      | `true`  | Show note about merged entries   |

## Outcome Tracking

Tasks tracked through full lifecycle: pending → in_progress → completed/abandoned.

### How It Affects Scoring

| Outcome       | Multiplier | Rationale                                                      |
|---------------|------------|----------------------------------------------------------------|
| `completed`   | 1.0        | Completed work is highest signal                               |
| `in_progress` | 0.7        | Work in progress is medium signal                              |
| `abandoned`   | 0.3        | Abandoned work is low signal (might indicate what *not* to do) |

### Configuration

```json
{
  "outcomeTracking": {
    "enabled": true,
    "outcomePriority": {
      "completed": 1.0,
      "in_progress": 0.7,
      "abandoned": 0.3
    },
    "trackDuration": true
  }
}
```

## File Caching

Caches parsed data to `.cache.json` to avoid redundant file reads.

### Configuration

```json
{
  "caching": {
    "enabled": true,
    "maxAgeSeconds": 60
  }
}
```

Cache is automatically invalidated when data files are written.

## Sync Server (Optional)

Sync memory across machines using a self-hosted server.

### Quick Start

```bash
node server/mneme-server.mjs
```

### Configuration

```json
{
  "sync": {
    "enabled": false,
    "serverUrl": null,
    "apiKey": null,
    "projectId": null,
    "timeoutMs": 10000,
    "retries": 3
  }
}
```

| Option      | Default | Description                                    |
|-------------|---------|------------------------------------------------|
| `enabled`   | `false` | Enable sync (local-only by default)            |
| `serverUrl` | `null`  | Server URL (e.g., "http://192.168.1.100:3847") |
| `apiKey`    | `null`  | API key if server requires auth                |
| `projectId` | `null`  | Override auto-detected project name            |
| `timeoutMs` | `10000` | Request timeout in milliseconds                |
| `retries`   | `3`     | Number of retries on failure                   |

### How It Works

1. **Session Start**: Pull files from server, acquire lock, start heartbeat
2. **During Session**: Heartbeat keeps lock alive (every 5 min)
3. **Session End**: Push changes, release lock

### Files Synced

`log.jsonl`, `summary.json`, `summary.md`, `remembered.json`, `entities.json`

### Files NOT Synced

`log.pending.jsonl`, `.cache.json`, `.last-session`, `active-tasks.json`, `handoff.json`

### Lock Behavior

- Locks auto-expire after 30 minutes (configurable)
- Heartbeat extends lock every 5 minutes during active session
- If locked by another machine, falls back to local-only mode

See `server/README.md` for server setup and deployment options.

## Concurrent Sessions

File locking prevents data corruption across concurrent sessions:

- **Log entries**: Write-locked during flush and summarization truncation
- **Remembered items**: `/remember` and `/forget` use file locks
- **Task tracking**: Session start prunes stale tasks (>24h); create/update are locked

**Known limitations:**
- Task tracking may show cross-session entries
- All sessions' activity goes into the same log (may produce blended summaries)
- For best results, use one session per project
