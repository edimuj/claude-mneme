---
name: status
description: Check plugin health and diagnose issues. Use when the user asks about mneme health, memory status, plugin errors, wants to troubleshoot memory issues, or sees error warnings at session start.
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-status.mjs"

# Clear the error log
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-status.mjs" --clear-errors
```

Returns JSON: `overall` (healthy/degraded/unhealthy), `checks` (config, claudeBinary, directories, memoryFiles, errorLog, sync), `errors`, `warnings`.

Common fixes:
- Claude binary not found → remove `claudePath` from config or set correct path
- Directories not writable → check permissions on `~/.claude-mneme/`
- Config parse error → check JSON syntax in `~/.claude-mneme/config.json`
- Log needs summarization → run `/summarize`
