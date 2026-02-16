<p align="center">
  <img src="assets/claude-mneme-mascot-200.png" alt="Claude Mneme" width="150">
</p>

<h1 align="center">Claude Mneme</h1>

<p align="center">
  <em>Persistent memory for Claude Code — so every session picks up where the last one left off</em>
</p>

<p align="center">
  <a href="#install">Install</a> •
  <a href="#what-you-get">What You Get</a> •
  <a href="#commands">Commands</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#sync-server">Sync Server</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-3.7.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node">
  <img src="https://img.shields.io/badge/claude--code-plugin-orange" alt="Claude Code Plugin">
</p>

---

## The Problem

Every Claude Code session starts from zero. Claude doesn't know what you were working on yesterday, which architectural decisions you've already made, or that you tried and rejected approach X last week.

You end up repeating context, re-explaining decisions, and watching Claude suggest things you've already ruled out.

**Claude Mneme fixes this.** It silently captures your sessions and injects the right context when you start a new one — project state, key decisions, recent work, and anything you've explicitly told it to remember. ~2,000 tokens of signal, zero effort from you.

## Install

```bash
claude plugin marketplace add edimuj/claude-mneme
claude plugin install claude-mneme@claude-mneme
```

Restart Claude Code. That's it — Mneme starts working automatically.

## What You Get

When you start a new session, Mneme injects a structured memory summary. Here's what that looks like in practice:

```
<claude-mneme project="my-saas-app">

Session started: 09:15 | Last session: Feb 10, 17:42 (15 hours ago)

## Last Session
**Working on:** Fix the Stripe webhook race condition
**Done:** Added idempotency key check before processing payment events
**Open:** Write integration test for duplicate webhook scenario

## Project Context
SaaS billing app with Stripe integration, PostgreSQL, Express backend.
Multi-tenant with per-org billing.

## Key Decisions
- Stripe webhooks over polling — real-time, less API usage
- PostgreSQL advisory locks for payment processing — prevents double-charges
- JWT auth with Redis session store — fast validation, easy revocation

## Current State
- Webhook handler: Implemented with idempotency checks
- Billing dashboard: In progress — invoice list done, usage charts pending
- Multi-currency support: Planned

## Recent Work
- [Feb 8] Fixed webhook signature verification for test environment
- [Feb 7] Added org-level billing isolation

## Recently Active
- `webhook-handler.ts` [worked on] (3x this week)
- `billing-service.ts` [worked on, discussed] (5x this week)
- `handlePaymentIntent` [worked on] (2x this week)

</claude-mneme>
```

Claude reads this context and immediately knows: what the project is, what decisions have been made (and why), what you were doing last session, and which files are hot right now. No "let me explore the codebase first" — it just picks up where you left off.

**Temporal awareness** — Claude Code has no sense of time between sessions. Mneme injects the current time and when you last worked on the project, so Claude knows whether your "last session" was 20 minutes ago or 3 days ago. Small detail, big difference in how it reasons about staleness and continuity.

## Why Mneme?

| Approach | Limitation |
|----------|------------|
| **MEMORY.md** (built-in) | Manual. You write and maintain it yourself. No automatic capture |
| **Heavy RAG/vector solutions** | Complex setup, high token cost, often retrieves noise over signal |
| **Claude Mneme** | Automatic capture, structured summarization, ~2K tokens at startup. Configurable if you want more |

Mneme sits in the middle: enough memory to be genuinely useful, lightweight enough that you forget it's there.

## Commands

### `/remember` — Save persistent context

```
/remember This project uses pnpm, not npm
/remember The auth system uses JWT tokens stored in Redis
/remember Tried Redis caching but serialization overhead made it slower
```

Remembered items are never auto-summarized — they persist until you remove them.

### `/forget` — Remove remembered items

```
/forget my preference about tabs     # AI finds matching entries
/forget                              # Lists all entries to choose from
```

### `/entity` — Query the knowledge index

```
/entity auth.ts                      # What does Mneme know about this file?
/entity handleLogin                  # Find references to a function
```

### `/summarize` — Force summarization

```
/summarize                           # Compress the log now
/summarize --dry-run                 # Preview what would be summarized
```

Summarization normally runs automatically when the log reaches 50 entries.

### `/status` — Health check

```
/status                              # Diagnose issues
/status --clear-errors               # Clear the error log
```

## Configuration

Edit `~/.claude-mneme/config.json`:

```json
{
  "maxLogEntriesBeforeSummarize": 50,
  "keepRecentEntries": 10,
  "model": "haiku"
}
```

See [`CONFIG_REFERENCE.md`](plugin/CONFIG_REFERENCE.md) for all options.

<details>
<summary><strong>Core Settings</strong></summary>

| Option | Default | Description |
|--------|---------|-------------|
| `maxLogEntriesBeforeSummarize` | `50` | Trigger summarization at this log size |
| `keepRecentEntries` | `10` | Recent entries to keep after summarization |
| `model` | `haiku` | Model for summarization (`haiku`, `sonnet`, `opus`) |
| `responseSummarization` | `"none"` | Response capture: `"none"`, `"extractive"`, or `"llm"` |
| `maxResponseLength` | `1000` | Max characters for captured responses |

</details>

<details>
<summary><strong>Context Injection</strong></summary>

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

| Section | Priority | Default |
|---------|----------|---------|
| `projectContext` | High | Always shown |
| `keyDecisions` | High | Last 10 |
| `currentState` | High | Last 10 |
| `recentWork` | Medium | Last 5 (within 7 days) |
| `recentEntries` | Low | Last 4 |

</details>

<details>
<summary><strong>Deduplication</strong></summary>

```json
{
  "deduplication": {
    "enabled": true,
    "timeWindowMinutes": 5
  }
}
```

When you work on something, multiple entries are created (prompt, task, commit). Deduplication groups entries within the time window and keeps only the highest-signal one.

</details>

<details>
<summary><strong>Entity Extraction</strong></summary>

```json
{
  "entityExtraction": {
    "enabled": true,
    "maxAgeDays": 30,
    "categories": {
      "files": true,
      "functions": true,
      "errors": true,
      "packages": true
    }
  }
}
```

Entities older than `maxAgeDays` are automatically pruned. Set to `0` to disable pruning.

</details>

## How It Works

### Architecture

Mneme has two server components — don't confuse them:

| Component | Location | Purpose |
|-----------|----------|---------|
| **Plugin Service** | `plugin/server/` | Local background process that hooks communicate with during a session. Handles log writes, deduplication, caching, and summarization |
| **Sync Server** | `server/` | Optional remote server for syncing memory across machines. Not needed for single-machine use |

### Lifecycle Hooks

Mneme hooks into Claude Code's lifecycle events:

```
SessionStart     → Injects memory context into the conversation
UserPromptSubmit → Captures your prompts (filtered for noise)
PostToolUse      → Captures task progress and git commits
SubagentStop     → Captures agent completion summaries
PreCompact       → Extracts context before conversation compaction
Stop             → Captures response, writes session handoff
```

### What Gets Captured

| Type | Source | Description |
|------|--------|-------------|
| `prompt` | UserPromptSubmit | Your requests and questions |
| `task` | TaskCreate/Update | Work focus and progress |
| `commit` | Bash (git) | Git commit messages |
| `agent` | SubagentStop | Agent completion summaries |
| `response` | Stop | Assistant's response |

### Smart Processing

Before injection, entries go through:

1. **Deduplication** — Groups related entries (prompt → task → commit), keeps highest-signal
2. **Relevance scoring** — Ranks by recency, file relevance, and entry type
3. **Outcome tracking** — Completed tasks rank higher than abandoned ones
4. **Entity extraction** — Indexes files, functions, errors for `/entity` lookups

### Noise Filtering

Automatically filtered out:
- Short prompts (<20 chars), confirmations ("yes", "ok", "continue")
- Slash commands and duplicate task updates

### Summarization

When the log reaches 50 entries, Mneme uses Claude Haiku to compress older entries into a structured summary — preserving key decisions, project context, and current state while discarding low-signal noise. The 10 most recent entries are kept as-is.

### Storage

```
~/.claude-mneme/
├── config.json                    # Global settings
└── projects/
    └── <project>/
        ├── log.jsonl              # Activity log (auto-summarized)
        ├── summary.json           # Structured summary
        ├── remembered.json        # Persistent /remember entries
        ├── entities.json          # Entity index
        ├── handoff.json           # Session handoff
        └── .last-session          # Timestamp for git tracking
```

## Sync Server

Optionally sync memory across machines with a self-hosted server.

```bash
# Start the server
node server/mneme-server.mjs

# Enable in config
{
  "sync": {
    "enabled": true,
    "serverUrl": "http://192.168.1.100:3847"
  }
}
```

Lock-based concurrency ensures one machine at a time per project. If the server is unreachable, Mneme continues with local memory.

<details>
<summary><strong>Sync Details</strong></summary>

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

**Configuration:**

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

**Server config** (`~/.mneme-server/config.json`):

```json
{
  "port": 3847,
  "dataDir": "~/.mneme-server",
  "apiKeys": ["your-secret-key"],
  "lockTTLMinutes": 30
}
```

For non-localhost deployments, enable API keys and consider a reverse proxy for HTTPS. See [`server/README.md`](server/README.md) for full server docs.

</details>

## Related Projects

| Project | Description |
|---------|-------------|
| [tokenlean](https://github.com/edimuj/tokenlean) | CLI toolkit for examining codebases while minimizing token usage |
| [claude-simple-status](https://github.com/edimuj/claude-simple-status) | Minimal statusline showing model, context, and quota |
| [vexscan](https://github.com/edimuj/vexscan) | Security scanner for AI agent plugins and configurations |
| [claude-workshop](https://github.com/edimuj/claude-workshop) | Collection of useful plugins and tools for Claude Code |

## License

[MIT](LICENSE) &copy; [Edin Mujkanovic](https://github.com/edimuj)
