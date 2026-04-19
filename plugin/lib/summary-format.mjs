export const MAX_DECISION_LINE = 160;

function localTime(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    });
  } catch {
    return ts;
  }
}

function stripPrefix(str, prefix) {
  if (typeof prefix === 'string') {
    return str.startsWith(prefix) ? str.slice(prefix.length) : str;
  }
  return str.replace(prefix, '');
}

function formatEntryBrief(entry) {
  const c = entry.content || '';
  switch (entry.type) {
    case 'prompt':
      return `User: ${stripPrefix(c, 'User: ')}`;
    case 'response':
      return `Assistant: ${stripPrefix(c, 'Assistant: ')}`;
    case 'agent': {
      const text = stripPrefix(c, /^\[[\w-]+\]\s*/);
      return `Agent (${entry.agent_type || 'unknown'}): ${text}`;
    }
    case 'task': {
      if (entry.action) {
        const outcome = entry.outcome && entry.outcome !== entry.action ? ` [${entry.outcome}]` : '';
        return `Task ${entry.action}: ${entry.subject}${outcome}`;
      }
      return `Task: ${c}`;
    }
    case 'commit':
      return `Commit: ${stripPrefix(c, 'Git commit: ')}`;
    default:
      return `(${entry.type}) ${c}`;
  }
}

export function formatEntry(entry) {
  const ts = localTime(entry.ts);
  let text = `[${ts}] ${formatEntryBrief(entry)}`;

  if (entry._mergedFrom && entry._mergedFrom.length > 0) {
    text += ` (also: ${entry._mergedFrom.join(', ')})`;
  }

  return text;
}

function groupIntoWorkUnits(entries, windowMs) {
  if (entries.length === 0) return [];

  const sorted = [...entries].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const groups = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = new Date(sorted[i].ts) - new Date(current[current.length - 1].ts);
    if (gap <= windowMs) {
      current.push(sorted[i]);
    } else {
      groups.push(current);
      current = [sorted[i]];
    }
  }
  groups.push(current);

  return groups.map(group => {
    const ts = group[0].ts;

    if (group.length === 1) {
      return { ts, text: formatEntryBrief(group[0]) };
    }

    const prompts = group.filter(e => e.type === 'prompt');
    const commits = group.filter(e => e.type === 'commit');
    const responses = group.filter(e => e.type === 'response');
    const tasks = group.filter(e => e.type === 'task');
    const agents = group.filter(e => e.type === 'agent');
    const other = group.filter(e => !['prompt', 'commit', 'response', 'task', 'agent'].includes(e.type));

    const parts = [];

    if (prompts.length > 0) {
      parts.push(`User: "${prompts.map(p => p.content).join('; ')}"`);
    }

    for (const t of tasks) {
      const brief = t.action ? `Task ${t.action}: ${t.subject}` : `Task: ${t.content}`;
      parts.push(brief);
    }
    for (const a of agents) {
      parts.push(`Agent: ${a.content}`);
    }

    if (commits.length > 0) {
      parts.push(`Commit: "${commits.map(c => c.content).join('; ')}"`);
    }

    if (responses.length > 0) {
      const responseText = responses.map(r => r.content).join(' ');
      const maxLen = 200;
      parts.push(`Result: ${responseText.length > maxLen ? responseText.slice(0, maxLen) + '...' : responseText}`);
    }

    for (const o of other) {
      parts.push(formatEntryBrief(o));
    }

    return { ts, text: parts.join(' → ') };
  });
}

export function formatEntriesForSummary(lines) {
  const entries = lines.map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);

  if (entries.length === 0) return '';

  const workUnits = groupIntoWorkUnits(entries, 5 * 60 * 1000);

  const byDay = new Map();
  for (const unit of workUnits) {
    const dayKey = new Date(unit.ts).toLocaleDateString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
    });
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(unit);
  }

  const sections = [];
  for (const [day, units] of byDay) {
    const items = units.map(u => `- ${u.text}`).join('\n');
    sections.push(`### ${day}\n${items}`);
  }

  return sections.join('\n\n');
}

export function emptyStructuredSummary() {
  return {
    projectContext: '',
    keyDecisions: [],
    currentState: [],
    recentWork: [],
    lastUpdated: null
  };
}

export function formatDecisionLine(d) {
  const decision = d.decision || '';
  if (!d.reason) return `- **${decision}**`;
  const full = `- **${decision}** — ${d.reason}`;
  if (full.length <= MAX_DECISION_LINE) return full;
  const budget = MAX_DECISION_LINE - decision.length - 8;
  if (budget < 20) return `- **${decision}**`;
  const reason = d.reason.slice(0, budget);
  const sentBreak = Math.max(reason.lastIndexOf('. '), reason.lastIndexOf('; '));
  if (sentBreak > budget * 0.4) return `- **${decision}** — ${reason.slice(0, sentBreak + 1).trim()}`;
  const wordBreak = reason.lastIndexOf(' ');
  if (wordBreak > budget * 0.4) return `- **${decision}** — ${reason.slice(0, wordBreak).trim()}...`;
  return `- **${decision}**`;
}

export function renderSummaryToMarkdown(summary, projectName, options = {}) {
  const sections = options.sections || {};
  const highLines = ['# Claude Memory Summary'];
  const mediumLines = [];

  if (summary.lastUpdated) {
    const ts = new Date(summary.lastUpdated).toISOString().replace('T', ' ').split('.')[0] + ' UTC';
    highLines.push(`\n*Last updated: ${ts}*`);
  }

  const pcConfig = sections.projectContext || { enabled: true };
  if (pcConfig.enabled !== false && summary.projectContext) {
    highLines.push('\n## Project Context');
    highLines.push(summary.projectContext);
  }

  const kdConfig = sections.keyDecisions || { enabled: true, maxItems: 10 };
  if (kdConfig.enabled !== false && summary.keyDecisions?.length > 0) {
    const maxItems = kdConfig.maxItems || 10;
    const decisions = summary.keyDecisions.slice(-maxItems);
    highLines.push('\n## Key Decisions');
    for (const d of decisions) {
      highLines.push(formatDecisionLine(d));
    }
  }

  const csConfig = sections.currentState || { enabled: true, maxItems: 10 };
  if (csConfig.enabled !== false && summary.currentState?.length > 0) {
    const maxItems = csConfig.maxItems || 10;
    const staleAfterDays = csConfig.staleAfterDays ?? 3;
    const completedPattern = /\b(fixed|completed|implemented|done|resolved|removed|merged)\b/i;
    const now = Date.now();

    const states = summary.currentState
      .filter(s => {
        if (staleAfterDays === 0) return true;
        if (!completedPattern.test(s.status)) return true;
        if (!s.updatedAt) return true;
        return (now - new Date(s.updatedAt).getTime()) < staleAfterDays * 86400000;
      })
      .slice(-maxItems);

    if (states.length > 0) {
      highLines.push('\n## Current State');
      for (const s of states) {
        highLines.push(`- **${s.topic}**: ${s.status}`);
      }
    }
  }

  const rwConfig = sections.recentWork || { enabled: true, maxItems: 5, maxAgeDays: 7 };
  if (rwConfig.enabled !== false && summary.recentWork?.length > 0) {
    const maxItems = rwConfig.maxItems || 5;
    const maxAgeDays = rwConfig.maxAgeDays || 7;
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

    const recentWork = summary.recentWork
      .filter(w => {
        if (!w.date) return true;
        const itemDate = new Date(w.date).getTime();
        return itemDate >= cutoff;
      })
      .slice(-maxItems);

    if (recentWork.length > 0) {
      mediumLines.push('\n## Recent Work');
      for (const w of recentWork) {
        const date = w.date ? `[${w.date}] ` : '';
        mediumLines.push(`- ${date}${w.summary}`);
      }
    }
  }

  return {
    high: highLines.join('\n'),
    medium: mediumLines.join('\n'),
    full: highLines.concat(mediumLines).join('\n')
  };
}

export function renderSummaryFull(summary, projectName) {
  const result = renderSummaryToMarkdown(summary, projectName, {});
  return result.full;
}
