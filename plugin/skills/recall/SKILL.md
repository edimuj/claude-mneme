---
name: recall
description: Inject filtered context from previous sessions. Use when the user says "recall", "what happened last session", "what did we work on", "inject previous context", or when you need context from a prior session to continue work. Also useful mid-session when the user references prior work you don't have context for.
---

## Your task

Recall and inject structured context from previous sessions into the current conversation. This mines the raw session logs to extract specific categories of information, trimmed to a token budget.

## How to use

Run the recall script with the desired categories and options:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-recall.mjs" [categories...] [--budget N] [--sessions N] [--from-log]
```

### Categories

| Category | What it extracts |
|----------|-----------------|
| `decisions` | Key decisions made (approach choices, tool selections, design calls) |
| `files` | Files read, written, edited — the working set with action types |
| `errors` | Errors encountered, failed commands, blockers |
| `todos` | Action items, TODOs, things left undone |
| `thinking` | Reasoning thread summaries — the "why" behind choices |
| `tools` | Tool call sequence and counts — shows the flow of work |
| `instructions` | User corrections and instructions given during the session |
| `all` | All of the above |

**Default** (no categories specified): `decisions files errors todos`

### Options

- `--budget N` — Token budget cap (default: 2000). Output is proportionally trimmed to fit.
- `--sessions N` — How many sessions back to recall (default: 1). Most recent first.
- `--from-log` — Force mining from raw JSONL logs (skip any cached data).

### Examples

```bash
# Default recall — decisions, files, errors, todos from last session
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-recall.mjs"

# Just decisions and errors
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-recall.mjs" decisions errors

# Everything with a larger budget
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-recall.mjs" all --budget 4000

# Last 3 sessions, just files touched
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-recall.mjs" files --sessions 3

# Thinking threads — understand the reasoning
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-recall.mjs" thinking --budget 3000
```

## When to use proactively

- User references work from a prior session you have no context for
- Resuming work after a context compaction where important details were lost
- Starting a session where the auto-injected summary isn't detailed enough
- User asks "what did we do last time" or "what files were we working on"

## Output

The script outputs structured markdown that you should present to the user or use as working context. The output is already trimmed to the token budget — inject it as-is.
