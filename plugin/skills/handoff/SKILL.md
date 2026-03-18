---
name: handoff
description: Create a session briefing for the next session — auto-loaded, then archived. Use when the user is wrapping up a session, says "save this for next time", "hand off", "brief the next session", or wants to ensure continuity before stopping work.
---

## Your task

Create a concise briefing that the next session will automatically receive at startup. Think of it as writing a note to your future self (or the next session's Claude).

## What to include

Reflect on the current session and generate a structured briefing with these fields:

- **summary** (required): 1-3 sentences on what was worked on and accomplished this session
- **keyDecisions**: Important decisions, trade-offs, or design choices made (array of strings)
- **currentState**: Where things stand right now — what's done, what's half-done
- **nextSteps**: What should happen next, in priority order (array of strings)
- **blockers**: Unresolved issues, questions, or things that need attention (array of strings)
- **context**: Any other important context that would be lost between sessions

Only include fields that have meaningful content. Don't pad with filler.

## How to save

Pipe JSON to the handoff script via stdin:

```bash
echo '{"summary":"...","keyDecisions":["..."],"currentState":"...","nextSteps":["..."],"blockers":["..."],"context":"..."}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-handoff.mjs"
```

The JSON must have at least a `summary` field. All other fields are optional.

## Important

- This replaces any previous unsent briefing (only one active at a time)
- The briefing is injected at next session start, then archived automatically
- Be specific and actionable — generic summaries waste context tokens
- If the user provided instructions after `/handoff`, incorporate them into the briefing
- If no specific instructions, use your knowledge of the session to write the best briefing you can

## Example

User: `/handoff`

Generate based on session context:
```json
{
  "summary": "Implemented the new auth middleware using JWT tokens. Added refresh endpoint and integration tests.",
  "keyDecisions": [
    "JWT over session tokens — stateless, scales better with the API gateway",
    "Refresh tokens stored in httpOnly cookies, not localStorage"
  ],
  "currentState": "Auth middleware is working and tested. Rate limiting endpoint exists but isn't wired up yet.",
  "nextSteps": [
    "Wire rate limiting into the auth middleware chain",
    "Add token revocation endpoint",
    "Update API docs with new auth flow"
  ],
  "blockers": [
    "CORS preflight issue with the staging API gateway — needs DevOps input"
  ]
}
```

User: `/handoff remember to check the flaky test in auth.test.mjs before continuing`

Include the user's note in the briefing alongside the session summary.
