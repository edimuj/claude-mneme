---
name: remember
description: Save something to memory for future sessions. Use when the user says "remember this", "save for later", "don't forget", or wants to persist any preference, fact, lesson, or note across sessions.
argument-hint: "[what to remember]"
---

Save to remembered.json (persists across all sessions, never auto-summarized or pruned):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-add.mjs" <type> "$ARGUMENTS"
```

Types: `preference` (coding style, tools) | `project` (status, goals) | `fact` (user/env info) | `note` (general) | `lesson` (failed approaches, anti-patterns)

If no content provided, ask what to remember. Default to `note` when ambiguous, `lesson` when something failed.

Keep content concise. Confirm what was saved. To remove items later: `/forget`.
