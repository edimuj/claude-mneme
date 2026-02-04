---
description: Remove entries from remembered items
---

## Your task

The user wants to remove something from their remembered items. They may have specified what to forget, or you may need to show them the list.

## How to use the forget script

The mem-forget script has three modes:

### List all entries
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-forget.mjs" --list
```
Returns JSON array of entries with their indices.

### Remove entries by index
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-forget.mjs" --remove 0,2,3
```
Removes entries at the specified indices (comma-separated).

### Find matching entries (AI-assisted)
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-forget.mjs" --match "description of what to forget"
```
Uses AI to identify which entries match the description. Returns matching indices.

## Workflow

### If the user specified what to forget (e.g., `/forget my tabs preference`)

1. Run the script with `--match` to find matching entries
2. If matches found, show the user what will be removed
3. Ask for confirmation before removing
4. On confirmation, run `--remove` with the indices

### If the user just said `/forget` with no content

1. Run `--list` to show all remembered items
2. Display them numbered (starting from 0) with type and content
3. Ask the user which ones to remove (they can specify by number or describe what to remove)
4. If they give numbers: confirm and remove those indices
5. If they describe what to remove: use `--match` to find them, confirm, then remove

## Guidelines

1. Always show the user exactly what will be removed before doing it
2. Require explicit confirmation before removing anything
3. After removal, confirm what was removed
4. If no matches found, let the user know and offer to list all entries

## Example interactions

User: `/forget my preference about tabs`
→ Run `--match "preference about tabs"`
→ Show: "Found 1 matching entry: [preference] Prefers tabs over spaces. Remove it?"
→ On yes: Run `--remove 0`
→ Confirm: "Removed 1 entry."

User: `/forget`
→ Run `--list`
→ Show numbered list of all entries
→ Ask: "Which would you like to remove? (Enter numbers or describe)"
→ User: "1 and 3"
→ Confirm: "Remove these 2 entries? [show them]"
→ On yes: Run `--remove 1,3`
