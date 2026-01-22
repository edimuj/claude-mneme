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

## Guidelines

1. Parse what the user wants to remember and choose the appropriate type
2. Keep the content concise but complete
3. Confirm what was saved after running the command
4. If ambiguous, default to `note` type

## Examples

User: `/remember I prefer functional programming over OOP`
→ Save as `preference`: "Prefers functional programming over OOP"

User: `/remember working on a React Native app called GhostTube`
→ Save as `project`: "Working on React Native app called GhostTube"

User: `/remember`
→ Ask: "What would you like me to remember?"
