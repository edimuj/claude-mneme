---
description: Check plugin health and diagnose issues
---

## Your task

The user wants to check the health status of the claude-mneme plugin. Run the health check and report the results clearly.

## How to check status

Run the health check script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-status.mjs"
```

To clear the error log:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-status.mjs" --clear-errors
```

## Understanding the output

The script returns JSON with:

- `overall`: "healthy", "degraded", or "unhealthy"
- `checks`: Individual check results
- `errors`: Critical issues that need fixing
- `warnings`: Non-critical issues to be aware of

### Check Categories

1. **config** - Is the config file valid?
2. **claudeBinary** - Can we find the claude executable for summarization?
3. **directories** - Are memory directories writable?
4. **memoryFiles** - Status of log, summary, remembered items, entities
5. **errorLog** - Recent errors from the last 24 hours
6. **sync** - Sync server configuration (if enabled)

## How to respond

Present the results in a clear, actionable format:

### If healthy:
> **Plugin Status: Healthy** ✓
>
> All checks passed. Memory is working correctly.
>
> - Log: X entries
> - Summary: Last updated Y ago
> - Remembered: Z items

### If degraded:
> **Plugin Status: Degraded** ⚠️
>
> The plugin is working but has warnings:
> - [list warnings]
>
> Recent errors:
> - [list if any]

### If unhealthy:
> **Plugin Status: Unhealthy** ✗
>
> Critical issues found:
> - [list errors with fixes]
>
> **How to fix:**
> 1. [specific fix instructions]

## Common issues and fixes

| Issue | Fix |
|-------|-----|
| Claude binary not found | Remove `claudePath` from config or set correct path |
| Directories not writable | Check permissions on `~/.claude-mneme/` |
| Config parse error | Check JSON syntax in `~/.claude-mneme/config.json` |
| Log needs summarization | Run `/summarize` to compress the log |
| Recent errors | Check error details and fix underlying issue |

## Clearing errors

If the user asks to clear the error log:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-status.mjs" --clear-errors
```

Confirm: "Error log cleared. Future errors will be logged fresh."
