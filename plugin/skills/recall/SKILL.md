---
name: recall
description: Inject filtered context from previous sessions. Use when the user says "recall", "what happened last session", "what did we work on", "inject previous context", or when you need context from a prior session to continue work. Also useful mid-session when the user references prior work you don't have context for.
argument-hint: "[categories...] [--budget N] [--sessions N]"
---

Mine previous session logs and inject structured context into the current conversation.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-recall.mjs" $ARGUMENTS
```

Categories: `decisions` `files` `errors` `todos` `thinking` `tools` `instructions` `all`
Default (no args): `decisions files errors todos`

Options: `--budget N` (token cap, default 2000) | `--sessions N` (how many back, default 1) | `--from-log` (force raw JSONL mining)

Output is structured markdown trimmed to the token budget — inject as-is.
