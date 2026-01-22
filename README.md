# Claude Mneme

> *Mneme (Greek: Μνήμη) - the muse of memory in Greek mythology*

**Persistent memory system for Claude Code** - automatically remembers context across sessions so Claude can pick up where you left off.

## Features

- **Automatic Context Capture** - Silently logs user prompts, task progress, and assistant responses
- **Smart Summarization** - Uses Haiku to compress old entries when the log grows too large
- **Project-Aware** - Maintains separate memory for each project you work on
- **Zero Configuration** - Works out of the box with sensible defaults
- **Lightweight** - Minimal overhead, non-blocking hooks

## How It Works

Claude Mneme uses Claude Code's hook system to capture context at key moments:

| Hook | What It Captures |
|------|-----------------|
| **SessionStart** | Injects memory summary + recent entries into session |
| **UserPromptSubmit** | Your prompts and questions |
| **PostToolUse** | Task progress (from TodoWrite) |
| **Stop** | Assistant's final response summary |

When your log reaches 50 entries, Mneme automatically summarizes the older entries using Haiku, keeping the 10 most recent for quick context.

## Installation

```bash
# Add the marketplace
claude plugin marketplace add edimuj/claude-mneme

# Install the plugin
claude plugin install claude-mneme@claude-mneme
```

## Memory Storage

```
~/.claude-mneme/
├── config.json                    # Global settings
└── projects/
    ├── my-project/
    │   ├── log.jsonl              # Recent memory entries
    │   └── summary.md             # AI-generated summary
    └── another-project/
        ├── log.jsonl
        └── summary.md
```

## Configuration

Edit `~/.claude-mneme/config.json`:

```json
{
  "maxLogEntriesBeforeSummarize": 50,
  "keepRecentEntries": 10,
  "maxResponseLength": 1000,
  "summarizeResponses": true,
  "maxSummarySentences": 4,
  "model": "claude-haiku-4-20250514"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `maxLogEntriesBeforeSummarize` | 50 | Trigger summarization when log reaches this size |
| `keepRecentEntries` | 10 | Number of recent entries to keep after summarization |
| `maxResponseLength` | 1000 | Maximum characters for captured responses |
| `summarizeResponses` | true | Enable extractive summarization of responses |
| `maxSummarySentences` | 4 | Max sentences to keep from each response |
| `model` | claude-haiku-4-20250514 | Model used for summarization |

## What Gets Filtered Out

To keep memory relevant, Mneme automatically filters:

- Very short prompts (<20 characters)
- Simple confirmations ("yes", "ok", "continue")
- Slash commands
- Duplicate task updates

## Requirements

- Claude Code CLI
- Node.js 18+

## License

MIT License - see [LICENSE](LICENSE)

## Authors

- **Edin Mujkanovic** ([@edimuj](https://github.com/edimuj))
- **Claude** ([Anthropic](https://claude.ai))

---

*Built with Claude Code*
