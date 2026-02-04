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
  <a href="#changelog">Changelog</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.4.0-blue" alt="Version">
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

### Inspecting Memory Manually

You can run the plugin scripts directly to see what would be injected:

```bash
# See what gets injected at session start
node ~/.claude/plugins/claude-mneme/scripts/session-start.mjs

# List all indexed entities
node ~/.claude/plugins/claude-mneme/scripts/mem-entity.mjs --list

# Query a specific entity
node ~/.claude/plugins/claude-mneme/scripts/mem-entity.mjs auth.ts

# List remembered items
node ~/.claude/plugins/claude-mneme/scripts/mem-forget.mjs --list
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

## Changelog

| Version | Changes |
|---------|---------|
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
