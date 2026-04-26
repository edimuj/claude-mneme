---
name: handoff
description: Create a session briefing for the next session — auto-loaded, then archived. Use when the user is wrapping up a session, says "save this for next time", "hand off", "brief the next session", or wants to ensure continuity before stopping work.
argument-hint: "[notes for next session]"
---

Create a briefing from the current session context. Pipe JSON to stdin:

```bash
echo '<json>' | node "${CLAUDE_PLUGIN_ROOT}/scripts/mem-handoff.mjs"
```

Required field: `summary` (1-3 sentences). Optional: `keyDecisions[]`, `currentState`, `nextSteps[]`, `blockers[]`, `context`.

```json
{
  "summary": "Implemented auth middleware with JWT tokens, added refresh endpoint and tests.",
  "keyDecisions": ["JWT over session tokens — stateless, scales with API gateway"],
  "currentState": "Auth working and tested. Rate limiting exists but not wired up.",
  "nextSteps": ["Wire rate limiting", "Add token revocation endpoint"],
  "blockers": ["CORS preflight issue with staging gateway — needs DevOps"]
}
```

Only include fields with meaningful content. Be specific and actionable. If user provided notes after `/handoff`, incorporate them. Replaces any previous unsent briefing. Auto-injected and archived at next session start.
