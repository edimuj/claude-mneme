<p align="center">
  <img src="assets/claude-mneme-mascot-200.png" alt="Claude Mneme Mascot" width="150">
</p>

<h1 align="center">Claude Mneme</h1>

<p align="center">
  <em>Persistent memory for Claude Code — remember context across sessions</em>
</p>

<p align="center">
  <a href="#installation">Installation</a> •
  <a href="#usage">Usage</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#sync-server">Sync Server</a> •
  <a href="#changelog">Changelog</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.5.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node">
  <img src="https://img.shields.io/badge/claude--code-plugin-orange" alt="Claude Code Plugin">
</p>

---

> *Mneme (Greek: Μνήμη) — the muse of memory in Greek mythology*

**Claude Mneme** automatically captures your coding sessions — prompts, tasks, commits, and responses — and injects relevant context into new sessions so Claude can pick up where you left off.

## Features

| | |
|---|---|
| 🧠 **Automatic Capture** | Silently logs prompts, tasks, commits, and responses |
| 📦 **Project-Aware** | Separate memory per project, auto-detected from git |
| ✨ **Smart Summarization** | Compresses old entries with Haiku when log grows |
| 🔍 **Entity Indexing** | Tracks files, functions, errors for smarter context |
| 📊 **Hierarchical Injection** | Prioritizes key decisions over low-signal entries |
| 🔄 **Multi-Machine Sync** | Optional server to sync memory across machines |
| ⚡ **Lightweight** | Non-blocking async hooks, minimal overhead |

## Installation

```bash
# Add the marketplace
claude plugin marketplace add edimuj/claude-mneme

# Install the plugin
claude plugin install claude-mneme@claude-mneme
```

## Usage

### Automatic Memory

Once installed, Mneme works automatically. Start a new session and you'll see injected context:

```
SessionStart: claude-mneme project="my-app"
# Claude Memory Summary
...recent activity and decisions...
```

### Manual Memory with `/remember`

Save important context that should persist permanently:

```bash
/remember I prefer TypeScript over JavaScript
/remember The auth system uses JWT tokens stored in Redis
/remember This project uses pnpm, not npm
```

> **Tip:** Remembered items are never auto-summarized — they persist until you remove them.

### Removing Memories with `/forget`

Remove remembered items when they're no longer relevant:

```bash
/forget my preference about tabs     # AI finds matching entries
/forget                              # Lists all entries to choose from
```

### Querying Memory with `/entity`

Look up what Mneme knows about a specific file, function, or entity:

```bash
/entity auth.ts                      # What do we know about auth.ts?
/entity handleLogin                  # Find references to a function
```

### Manual Summarization with `/summarize`

Force immediate summarization of the activity log:

```bash
/summarize                           # Summarize now
/summarize --dry-run                 # Preview what would be summarized
```

> **Tip:** Summarization normally runs automatically at 50 entries. Use `/summarize` after busy sessions to compress the log immediately.

### Inspecting Memory Manually

You can run the plugin scripts directly to see what would be injected:

```bash
# See what gets injected at session start
node ~/.claude/plugins/marketplaces/claude-mneme/plugin/scripts/session-start.mjs

# List all indexed entities
node ~/.claude/plugins/marketplaces/claude-mneme/plugin/scripts/mem-entity.mjs --list

# Query a specific entity
node ~/.claude/plugins/marketplaces/claude-mneme/plugin/scripts/mem-entity.mjs auth.ts

# List remembered items
node ~/.claude/plugins/marketplaces/claude-mneme/plugin/scripts/mem-forget.mjs --list

# Preview what would be summarized
node ~/.claude/plugins/marketplaces/claude-mneme/plugin/scripts/mem-summarize.mjs --dry-run

# Force manual summarization
node ~/.claude/plugins/marketplaces/claude-mneme/plugin/scripts/mem-summarize.mjs
```

> **Tip:** Run these from your project directory to see project-specific memory.

## Configuration

Edit `~/.claude-mneme/config.json` to customize behavior:

```json
{
  "maxLogEntriesBeforeSummarize": 50,
  "keepRecentEntries": 10,
  "model": "haiku"
}
```

<details>
<summary><strong>Core Settings</strong></summary>

| Option | Default | Description |
|--------|---------|-------------|
| `maxLogEntriesBeforeSummarize` | `50` | Trigger summarization at this log size |
| `keepRecentEntries` | `10` | Recent entries to keep after summarization |
| `model` | `haiku` | Model for summarization (`haiku`, `sonnet`, `opus`) |
| `maxResponseLength` | `1000` | Max characters for captured responses |

</details>

<details>
<summary><strong>Context Injection Settings</strong></summary>

Control what gets injected at session start:

```json
{
  "contextInjection": {
    "sections": {
      "projectContext": { "enabled": true },
      "keyDecisions": { "enabled": true, "maxItems": 10 },
      "currentState": { "enabled": true, "maxItems": 10 },
      "recentWork": { "enabled": true, "maxItems": 5, "maxAgeDays": 7 },
      "recentEntries": { "enabled": true, "maxItems": 4 }
    }
  }
}
```

| Section | Priority | Default Items |
|---------|----------|---------------|
| `projectContext` | High | Always shown |
| `keyDecisions` | High | Last 10 |
| `currentState` | High | Last 10 |
| `recentWork` | Medium | Last 5 (within 7 days) |
| `recentEntries` | Low | Last 4 |

</details>

<details>
<summary><strong>Deduplication Settings</strong></summary>

Group related entries and keep highest-signal:

```json
{
  "deduplication": {
    "enabled": true,
    "timeWindowMinutes": 5
  }
}
```

When you work on something, multiple entries are created (prompt → task → commit). Deduplication groups entries within the time window and keeps only the most important one.

</details>

<details>
<summary><strong>Entity Extraction Settings</strong></summary>

Track files, functions, and errors:

```json
{
  "entityExtraction": {
    "enabled": true,
    "categories": {
      "files": true,
      "functions": true,
      "errors": true,
      "packages": true
    }
  }
}
```

</details>

## How It Works

Mneme uses Claude Code's hook system to capture context at key moments:

```
SessionStart     → Injects memory context (hierarchical)
UserPromptSubmit → Captures your prompts (filtered for noise)
PostToolUse      → Captures task progress and git commits
SubagentStop     → Captures agent completion summaries
Stop             → Captures assistant's final response
```

### What Gets Injected

At session start, Mneme injects context in priority order:

```
<claude-mneme project="my-app">
┌─────────────────────────────────────────────┐
│  HIGH PRIORITY (always shown)               │
├─────────────────────────────────────────────┤
│  ## Project Context                         │
│  What this project is about                 │
│                                             │
│  ## Key Decisions                           │
│  - Architecture choices                     │
│  - Technology selections                    │
│                                             │
│  ## Current State                           │
│  - What's implemented                       │
│  - What's in progress                       │
│                                             │
│  ## Remembered                              │
│  - Your /remember items                     │
├─────────────────────────────────────────────┤
│  MEDIUM PRIORITY (if recent/relevant)       │
├─────────────────────────────────────────────┤
│  ## Recent Work                             │
│  - Last 7 days of activity                  │
│                                             │
│  ## Changes Since Last Session              │
│  - Git commits since you left               │
│                                             │
│  ## Recently Active                         │
│  - Hot files and functions                  │
├─────────────────────────────────────────────┤
│  LOW PRIORITY (minimal)                     │
├─────────────────────────────────────────────┤
│  ## Recent Activity                         │
│  - Last 4 deduplicated entries              │
└─────────────────────────────────────────────┘
</claude-mneme>
```

### What Gets Captured

| Type | Source | Description |
|------|--------|-------------|
| `prompt` | UserPromptSubmit | Your requests and questions |
| `task` | TaskCreate/Update | Work focus and progress (with outcome) |
| `commit` | Bash (git) | Git commit messages |
| `agent` | SubagentStop | Agent completion summaries |
| `response` | Stop | Assistant's summarized response |

### Smart Processing

Before injection, entries are processed:

1. **Deduplication** — Groups related entries (prompt → task → commit) and keeps highest-signal
2. **Relevance scoring** — Ranks by recency, file relevance, and entry type
3. **Outcome tracking** — Completed tasks rank higher than abandoned ones
4. **Entity extraction** — Indexes files, functions, errors for smarter context

### What Gets Filtered

To reduce noise, Mneme automatically filters:
- Short prompts (<20 chars)
- Confirmations ("yes", "ok", "continue")
- Slash commands
- Duplicate task updates

### Storage Structure

```
~/.claude-mneme/
├── config.json                    # Global settings
└── projects/
    └── my-project/
        ├── log.jsonl              # Recent memory entries
        ├── summary.json           # AI-generated structured summary
        ├── remembered.json        # Persistent /remember entries
        ├── entities.json          # Indexed entities (files, functions)
        ├── .cache.json            # Parsed data cache
        └── .last-session          # Timestamp for git tracking
```

## Sync Server

Optionally sync memory across multiple machines using a self-hosted server.

### Quick Start

```bash
# 1. Start the server (on your home network or a VPS)
node server/mneme-server.mjs

# 2. Enable sync in config (~/.claude-mneme/config.json)
{
  "sync": {
    "enabled": true,
    "serverUrl": "http://192.168.1.100:3847"
  }
}

# 3. Restart Claude Code to pick up changes
```

### How It Works

```
Machine A                          Server                          Machine B
    │                                │                                │
    ├── Session Start ──────────────►│                                │
    │   (acquire lock, pull)         │                                │
    │                                │                                │
    │   ... working ...              │   (locked by A)                │
    │                                │                                │
    │                                │◄────────── Session Start ──────┤
    │                                │   (lock failed, local-only)    │
    │                                │                                │
    ├── Session End ────────────────►│                                │
    │   (push, release lock)         │                                │
    │                                │                                │
    │                                │◄────────── Session Start ──────┤
    │                                │   (acquire lock, pull changes) │
```

- **Lock-based concurrency**: One machine at a time per project
- **Graceful fallback**: If server is unreachable or locked, continues with local memory
- **Heartbeat keepalive**: Lock auto-extends during active sessions
- **Selective sync**: Only syncs memory files, not temporary/cache files

<details>
<summary><strong>Sync Configuration</strong></summary>

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

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Enable sync (local-only by default) |
| `serverUrl` | `null` | Server URL (e.g., `http://192.168.1.100:3847`) |
| `apiKey` | `null` | API key if server requires auth |
| `projectId` | `null` | Override auto-detected project name |
| `timeoutMs` | `10000` | Request timeout in milliseconds |

</details>

<details>
<summary><strong>Server Configuration</strong></summary>

Create `~/.mneme-server/config.json` on the server:

```json
{
  "port": 3847,
  "dataDir": "~/.mneme-server",
  "apiKeys": ["your-secret-key"],
  "lockTTLMinutes": 30
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `port` | `3847` | Port to listen on |
| `dataDir` | `~/.mneme-server` | Where to store project data |
| `apiKeys` | `[]` | API keys for auth (empty = no auth) |
| `lockTTLMinutes` | `30` | Lock expiration time |

</details>

<details>
<summary><strong>Running as a Service</strong></summary>

**systemd (Linux):**

```ini
# /etc/systemd/system/mneme-server.service
[Unit]
Description=Mneme Sync Server
After=network.target

[Service]
Type=simple
User=your-username
ExecStart=/usr/bin/node /path/to/server/mneme-server.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable mneme-server
sudo systemctl start mneme-server
```

**Docker:**

```bash
docker run -d -p 3847:3847 -v ~/.mneme-server:/root/.mneme-server \
  node:20-alpine node /app/mneme-server.mjs
```

</details>

> **Note:** For security, enable API keys for any non-localhost deployment and consider putting behind a reverse proxy (nginx, caddy) for HTTPS.

See [`server/README.md`](server/README.md) for full documentation.

## Changelog

| Version | Changes |
|---------|---------|
| **2.5.0** | Optional sync server for multi-machine memory sync |
| **2.4.0** | Entity extraction, `/entity`, hierarchical injection, deduplication, outcome tracking, caching |
| **2.3.0** | Relevance scoring, compaction hooks, incremental summarization, `/forget` |
| **2.2.0** | Continuous summarization on every log write |
| **2.1.0** | TaskCreate/TaskUpdate hooks, SubagentStop capture |
| **2.0.0** | Renamed to claude-mneme, response-based capture |

<details>
<summary>Earlier versions</summary>

| Version | Changes |
|---------|---------|
| **1.3.0** | UserPromptSubmit hook, TodoWrite capture |
| **1.2.0** | Initial release |

</details>

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

[MIT](LICENSE) © [Edin Mujkanovic](https://github.com/edimuj)

---

<p align="center">
  <sub>Built with Claude Code</sub>
</p>
