---
description: Save something to memory for future sessions
---

## Your task

The user wants to save something to memory. They may have provided the content after the /remember command, or you may need to ask them what to remember.

If the user provided content (e.g., `/remember I prefer using TypeScript`), save it directly.

If no content was provided, ask the user: "What would you like me to remember?"

## How to save memories

Use the mem-add script to save the memory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-add.mjs" <type> "<content>"
```

Types to use:
- `preference` - User preferences (coding style, tools, workflows)
- `project` - Project information and status
- `fact` - Facts about the user or environment
- `note` - General notes
- `lesson` - Lessons learned, anti-patterns, approaches that failed — things to avoid repeating

## How it works

Remembered items are stored in a dedicated persistent file (`remembered.json`) separate from the activity log. They are **never summarized or removed automatically** — they are injected into every session exactly as saved.

If the user wants to remove or edit remembered items, they must manually edit the file:
`~/.claude-mneme/projects/<project>/remembered.json`

Let the user know this when saving, e.g.: "Saved. This will persist across all future sessions. To remove it later, edit `remembered.json` in your project's memory directory."

## Guidelines

1. Parse what the user wants to remember and choose the appropriate type
2. Keep the content concise but complete
3. Confirm what was saved and briefly explain persistence
4. If ambiguous, default to `note` type
5. Use `lesson` when the user describes something that didn't work, a mistake to avoid, or an anti-pattern discovered

## Examples

User: `/remember I prefer functional programming over OOP`
-> Save as `preference`: "Prefers functional programming over OOP"

User: `/remember working on a React Native app called GhostTube`
-> Save as `project`: "Working on React Native app called GhostTube"

User: `/remember don't use git reset --hard in this repo, it wipes untracked test fixtures`
-> Save as `lesson`: "Don't use git reset --hard — it wipes untracked test fixtures"

User: `/remember tried using Redis for caching but latency was worse than in-memory due to serialization overhead`
-> Save as `lesson`: "Redis caching attempt failed — serialization overhead made it slower than in-memory"

User: `/remember`
-> Ask: "What would you like me to remember?"
