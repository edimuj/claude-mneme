# Claude Mneme

Persistent memory system for Claude Code - remembers context across sessions.

## How It Works

1. **SessionStart**: Injects memory context (summary + recent entries) into session
2. **UserPromptSubmit**: Captures user prompts to understand intent and context
3. **PostToolUse**: Captures task progress (TaskCreate, TaskUpdate, TodoWrite) and git commits
4. **SubagentStop**: Captures summaries from specialized agents when they complete
5. **Stop**: Captures assistant response, summarizes old entries using Haiku when threshold reached

## What Gets Captured

| Type | Source | Example |
|------|--------|---------|
| `prompt` | UserPromptSubmit | User requests and questions |
| `task` | TaskCreate, TaskUpdate, TodoWrite | Current work focus and progress |
| `commit` | Bash (git commit) | Git commit messages |
| `agent` | SubagentStop | Specialized agent completion summaries |
| `response` | Stop | Assistant's summarized response |

## Automatic Filtering

The plugin automatically filters out noise:
- Very short prompts (<20 chars)
- Confirmations ("yes", "ok", "continue")
- Slash commands
- Duplicate task updates
- Responses are extractively summarized using action words

## Manual Memory with /remember

Use the `/remember` command to manually save memories:

```
/remember I prefer TypeScript over JavaScript
/remember The auth system uses JWT tokens stored in Redis
/remember Working on a React Native app called GhostTube
```

Memory types for manual entries:
- `preference` - User preferences (coding style, tools, workflows)
- `project` - Project information and status
- `fact` - Facts about the user or environment
- `note` - General notes (default)

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
  "maxResponseLength": 1000,
  "summarizeResponses": true,
  "maxSummarySentences": 4,
  "model": "haiku"
}
```

## Version History

- **2.1.0** - Added TaskCreate/TaskUpdate hooks for new task tools, SubagentStop capture
- **2.0.0** - Renamed to claude-mneme, refactored to capture assistant responses instead of tool-level noise
- **1.3.0** - Added UserPromptSubmit hook and TodoWrite capture for richer context
- **1.2.0** - Initial release with SessionStart, PostToolUse, Stop hooks
