# Claude Mneme

> *Mneme (Greek: Μνήμη) - the muse of memory in Greek mythology*

**Persistent memory system for Claude Code** - automatically remembers context across sessions so Claude can pick up where you left off.

## Features

- **Automatic Context Capture** - Silently logs user prompts, task progress, git commits, and assistant responses
- **Subagent Tracking** - Captures summaries from specialized agents when they complete tasks
- **Smart Summarization** - Uses Haiku to compress old entries when the log grows too large
- **Project-Aware** - Maintains separate memory for each project you work on
- **Zero Configuration** - Works out of the box with sensible defaults
- **Lightweight** - Minimal overhead, non-blocking hooks

## How It Works

Claude Mneme uses Claude Code's hook system to capture context at key moments:

| Hook | What It Captures |
|------|-----------------|
| **SessionStart** | Injects memory summary, git changes since last session, and recent entries |
| **UserPromptSubmit** | Your prompts and questions |
| **PostToolUse** | Task progress (TaskCreate, TaskUpdate, TodoWrite) and git commits |
| **SubagentStop** | Summaries from specialized agents (explore, test-runner, etc.) |
| **Stop** | Assistant's final response summary |

When your log reaches 50 entries, Mneme automatically summarizes the older entries using Haiku, keeping the 10 most recent for quick context. Summarization is checked after every log write, so you don't have to wait for session end.

## Entry Types

| Type | Source | Description |
|------|--------|-------------|
| `prompt` | UserPromptSubmit | User requests and questions |
| `task` | TaskCreate, TaskUpdate, TodoWrite | Current work focus and progress |
| `commit` | Bash (git commit) | Git commit messages |
| `agent` | SubagentStop | Specialized agent completion summaries |
| `response` | Stop | Assistant's summarized response |
| `preference` | /remember | User preferences (coding style, tools) |
| `project` | /remember | Project information and status |
| `fact` | /remember | Facts about user or environment |
| `note` | /remember | General notes |

## Installation

```bash
# Add the marketplace
claude plugin marketplace add edimuj/claude-mneme

# Install the plugin
claude plugin install claude-mneme@claude-mneme
```

## Manual Memory with /remember

Use the `/remember` command to manually save memories:

```
/remember I prefer TypeScript over JavaScript
/remember The auth system uses JWT tokens stored in Redis
/remember Working on a React Native app called GhostTube
```

Types are automatically inferred, or you can be explicit about preferences, project info, facts, or notes.

## Memory Storage

```
~/.claude-mneme/
├── config.json                    # Global settings
└── projects/
    ├── my-project/
    │   ├── log.jsonl              # Recent memory entries
    │   ├── summary.md             # AI-generated summary
    │   ├── remembered.json        # Persistent /remember entries
    │   └── .last-session          # Timestamp for git changes tracking
    └── another-project/
        ├── log.jsonl
        ├── summary.md
        ├── remembered.json
        └── .last-session
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
  "model": "haiku"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `maxLogEntriesBeforeSummarize` | 50 | Trigger summarization when log reaches this size |
| `keepRecentEntries` | 10 | Number of recent entries to keep after summarization |
| `maxResponseLength` | 1000 | Maximum characters for captured responses |
| `summarizeResponses` | true | Enable extractive summarization of responses |
| `maxSummarySentences` | 4 | Max sentences to keep from each response |
| `model` | haiku | Model alias used for summarization (haiku, sonnet, opus) |

## What Gets Filtered Out

To keep memory relevant, Mneme automatically filters:

- Very short prompts (<20 characters)
- Simple confirmations ("yes", "ok", "continue")
- Slash commands
- Duplicate task updates

## Requirements

- Claude Code CLI
- Node.js 18+

## Version History

- **2.3.0** - Git changes since last session in injection, 24h timestamps, async logging hooks, response filtering, task tracking cleanup
- **2.2.0** - Summarization now triggers on every log write instead of only at session end
- **2.1.0** - Added TaskCreate/TaskUpdate hooks for new task tools, SubagentStop capture
- **2.0.0** - Renamed to claude-mneme, refactored to capture assistant responses instead of tool-level noise
- **1.3.0** - Added UserPromptSubmit hook and TodoWrite capture for richer context
- **1.2.0** - Initial release with SessionStart, PostToolUse, Stop hooks

## License

MIT License - see [LICENSE](LICENSE)

## Authors

- **Edin Mujkanovic** ([@edimuj](https://github.com/edimuj))
- **Claude** ([Anthropic](https://claude.ai))

---

*Built with Claude Code*
