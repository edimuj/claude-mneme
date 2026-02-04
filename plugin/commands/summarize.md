---
description: Force immediate memory summarization
---

## Your task

The user wants to manually trigger memory summarization. This compresses older log entries into the structured summary, freeing up space in the activity log.

## When to use this

Summarization normally runs automatically when the log reaches 50 entries. Use `/summarize` to:
- Force summarization before that threshold
- Compress the log after a busy session
- Update the summary with recent work

## How to summarize

First, check what would be summarized with a dry run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-summarize.mjs" --dry-run
```

This shows:
- Number of log entries
- How many would be summarized vs kept
- Whether a summary already exists

If the user confirms (or didn't ask for dry-run), run the actual summarization:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-summarize.mjs"
```

## Understanding the output

The script outputs JSON with status:

- `status: "success"` - Summarization completed
- `status: "empty"` - No log entries to summarize
- `status: "skipped"` - Not enough entries (minimum 3 required)
- `status: "locked"` - Another summarization is in progress
- `status: "error"` - Something went wrong

## What happens during summarization

1. Pending log entries are flushed
2. Entries are deduplicated (related entries grouped)
3. Older entries are sent to Haiku for analysis
4. Summary is updated with new decisions, state, and work
5. Log is trimmed to keep only recent entries (default: 10)

## Configuration

These settings in `~/.claude-mneme/config.json` affect summarization:

- `keepRecentEntries` (default: 10) - Entries to keep after summarization
- `model` (default: "haiku") - Model for summarization

## Example responses

After successful summarization:
> "Summarized 42 entries into the project memory. Kept the 10 most recent entries in the log. The summary now includes [brief description of what was added]."

If nothing to summarize:
> "The log only has 5 entries, which is below the minimum threshold. Summarization will run automatically when you have more activity, or you can wait until there's more to compress."

If already running:
> "Summarization is already in progress. Please wait a moment and try again."
