---
name: summarize
description: Force immediate memory summarization. Use when the user wants to compress the activity log, trigger summarization manually, or says "summarize memory", "compress the log", or "update the summary".
argument-hint: "[--dry-run]"
---

Compress older log entries into the structured summary:

```bash
# Preview what would be summarized
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-summarize.mjs" --dry-run

# Run summarization
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-summarize.mjs"
```

Returns JSON status: `success`, `empty` (no entries), `skipped` (< 3 entries), `locked` (already running), `error`.

Normally runs automatically at 50 entries. Use this to force it earlier or after a busy session.
