---
name: entity
description: Look up what Mneme knows about a file, function, or entity. Use when the user asks "what do you know about X", wants to check entity history, or asks about file/function activity and mentions.
argument-hint: "[entity name]"
---

Query the entity index for files, functions, errors, or packages:

```bash
# Search by name (partial match)
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-entity.mjs" $ARGUMENTS

# List all entities (optionally filtered)
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-entity.mjs" --list [--category files|functions|errors|packages]
```

Returns JSON with `matches[]`: each has `name`, `category`, `mentions`, `lastSeen`, `contexts`.

If no query provided, ask the user what entity to look up.
