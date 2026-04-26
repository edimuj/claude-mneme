---
name: forget
description: Remove entries from remembered items. Use when the user wants to delete, remove, or clear a previously remembered item, or says "forget this", "remove that memory", or "clear my preferences".
argument-hint: "[what to forget]"
---

Three modes:

```bash
# List all entries with indices
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-forget.mjs" --list

# AI-match entries by description → returns indices
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-forget.mjs" --match "$ARGUMENTS"

# Remove by index (comma-separated)
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-forget.mjs" --remove 0,2,3
```

Workflow:
1. If user specified what to forget → `--match` to find, show matches, confirm, then `--remove`
2. If bare `/forget` → `--list`, show numbered entries, ask which to remove, confirm, then `--remove`

Always show what will be removed and get confirmation before deleting.
