---
description: Look up what Mneme knows about a file, function, or entity
---

## Your task

The user wants to query what Mneme knows about a specific entity (file, function, error, or package). They may have provided the entity name after the command.

If the user provided a query (e.g., `/entity auth.ts`), search for it directly.

If no query was provided, ask the user: "What entity would you like to look up? (e.g., a file name, function, or package)"

## How to query entities

Use the mem-entity script to search the entity index:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-entity.mjs" [options] [query]
```

Options:
- `--list` - List all indexed entities with their mention counts
- `--category <cat>` - Filter by category: files, functions, errors, packages
- `<query>` - Search for entities matching this name (partial match supported)

## Examples

```bash
# Look up a specific file
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-entity.mjs" auth.ts

# List all indexed files
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-entity.mjs" --list --category files

# Search for functions containing "handle"
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-entity.mjs" --category functions handle
```

## Output format

The script returns JSON with:
- `matches` - Entities matching the query
- Each match includes: `name`, `category`, `mentions`, `lastSeen`, `contexts` (recent activity)

## How to respond

1. Run the query
2. Present results in a readable format, highlighting:
   - How many times the entity was mentioned
   - When it was last seen
   - Recent contexts where it appeared
3. If no matches found, suggest similar entities or let user know
4. For broad queries, summarize the top results

## Example response

For `/entity auth.ts`:

> **auth.ts** (file) — 12 mentions, last seen 2 hours ago
>
> Recent activity:
> - [commit] Added JWT validation to auth middleware
> - [task] Implementing auth flow
> - [prompt] User asked about auth token refresh
