# Claude Mneme

Persistent memory system for Claude Code - remembers context across sessions.

## How It Works

1. **SessionStart**: Injects memory context (summary + recent entries) into session
2. **UserPromptSubmit**: Captures user prompts to understand intent and context
3. **PostToolUse**: Captures file changes, commands, and task progress
4. **Stop**: Summarizes old entries using Haiku when threshold is reached

## What Gets Captured

| Type | Source | Example |
|------|--------|---------|
| `prompt` | UserPromptSubmit | User requests and questions |
| `task` | TodoWrite | Current work focus and progress |
| `response` | Stop | Assistant's summarized response |

## Automatic Filtering

The plugin automatically filters out noise:
- Very short prompts (<20 chars)
- Confirmations ("yes", "ok", "continue")
- Slash commands
- Duplicate todo updates
- Responses are extractively summarized using action words

## Manual Memory with /remember

Use the `/remember` command to manually save memories:

```
/remember I prefer TypeScript over JavaScript
/remember The auth system uses JWT tokens stored in Redis
```

## Memory Storage

- `~/.claude-mneme/projects/<project>/log.jsonl` - Recent memory entries
- `~/.claude-mneme/projects/<project>/summary.md` - AI-generated summary
- `~/.claude-mneme/config.json` - Global settings

## Configuration

Edit `~/.claude-mneme/config.json`:
```json
{
  "maxLogEntriesBeforeSummarize": 50,
  "keepRecentEntries": 10,
  "model": "claude-haiku-4-20250514",
  "claudePath": "claude"
}
```

## Version History

- **2.0.0** - Renamed to claude-mneme, refactored to capture assistant responses instead of tool-level noise
- **1.3.0** - Added UserPromptSubmit hook and TodoWrite capture for richer context
- **1.2.0** - Initial release with SessionStart, PostToolUse, Stop hooks
