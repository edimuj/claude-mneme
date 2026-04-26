import { findSessionLogs, parseTranscript, mineAll } from './mine.mjs';
import { getProjectRoot } from './utils.mjs';

const DEFAULT_BUDGET = 2000;
const DEFAULT_SESSIONS = 1;
const CHARS_PER_TOKEN = 4;

const ALL_CATEGORIES = ['decisions', 'files', 'errors', 'todos', 'thinking', 'tools', 'instructions'];
const DEFAULT_CATEGORIES = ['decisions', 'files', 'errors', 'todos'];

const BUDGET_WEIGHTS = {
  decisions: 0.30,
  files: 0.15,
  errors: 0.20,
  todos: 0.10,
  thinking: 0.15,
  tools: 0.05,
  instructions: 0.05,
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(input) {
  const args = (input || '').split(/\s+/).filter(Boolean);
  let budget = DEFAULT_BUDGET;
  let sessions = DEFAULT_SESSIONS;
  let fromLog = false;
  const categories = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--budget' && args[i + 1]) { budget = parseInt(args[++i], 10) || DEFAULT_BUDGET; }
    else if (a === '--sessions' && args[i + 1]) { sessions = parseInt(args[++i], 10) || DEFAULT_SESSIONS; }
    else if (a === '--from-log') { fromLog = true; }
    else if (a === 'all') { categories.push(...ALL_CATEGORIES); }
    else if (ALL_CATEGORIES.includes(a)) { categories.push(a); }
  }

  return {
    categories: categories.length ? [...new Set(categories)] : DEFAULT_CATEGORIES,
    budget,
    sessions,
    fromLog,
  };
}

// ---------------------------------------------------------------------------
// Token budget allocation
// ---------------------------------------------------------------------------

function allocateBudget(categories, budget) {
  const total = categories.reduce((s, c) => s + (BUDGET_WEIGHTS[c] || 0.1), 0);
  const alloc = {};
  for (const c of categories) {
    alloc[c] = Math.floor(budget * (BUDGET_WEIGHTS[c] || 0.1) / total);
  }
  return alloc;
}

function charBudget(tokenBudget) {
  return tokenBudget * CHARS_PER_TOKEN;
}

// ---------------------------------------------------------------------------
// Formatters — each returns a string trimmed to charLimit
// ---------------------------------------------------------------------------

function formatDecisions(items, limit) {
  if (!items.length) return '';
  let out = `### Decisions (${items.length})\n`;
  for (const d of items) {
    const line = `- ${d}\n`;
    if (out.length + line.length > limit) break;
    out += line;
  }
  return out;
}

function formatFiles(items, limit) {
  if (!items.length) return '';
  let out = `### Files Touched (${items.length})\n`;
  const byAction = { write: [], edit: [], read: [], git: [] };
  for (const f of items) {
    for (const a of f.actions) {
      (byAction[a] || (byAction.read)).push(f.path);
    }
  }
  for (const [action, paths] of Object.entries(byAction)) {
    if (!paths.length) continue;
    const label = action.charAt(0).toUpperCase() + action.slice(1);
    const line = `**${label}**: ${paths.join(', ')}\n`;
    if (out.length + line.length > limit) break;
    out += line;
  }
  return out;
}

function formatErrors(items, limit) {
  if (!items.length) return '';
  let out = `### Errors (${items.length})\n`;
  for (const e of items) {
    const text = e.text.split('\n')[0].slice(0, 150);
    const tool = e.tool && e.tool !== 'unknown' ? ` [${e.tool}]` : '';
    const line = `- ${text}${tool}\n`;
    if (out.length + line.length > limit) break;
    out += line;
  }
  return out;
}

function formatTodos(items, limit) {
  if (!items.length) return '';
  let out = `### Todos (${items.length})\n`;
  for (const t of items) {
    const line = `- ${t}\n`;
    if (out.length + line.length > limit) break;
    out += line;
  }
  return out;
}

function formatThinking(items, limit) {
  if (!items.length) return '';
  let out = `### Thinking Threads (${items.length})\n`;
  for (const t of items) {
    const line = `- ${t.summary} (${Math.round(t.length / CHARS_PER_TOKEN)}t)\n`;
    if (out.length + line.length > limit) break;
    out += line;
  }
  return out;
}

function formatTools(data, limit) {
  if (!data.total) return '';
  let out = `### Tool Flow (${data.total} calls)\n`;
  for (const [name, count] of data.counts) {
    const line = `- ${name}: ${count}\n`;
    if (out.length + line.length > limit) break;
    out += line;
  }
  return out;
}

function formatInstructions(items, limit) {
  if (!items.length) return '';
  let out = `### User Instructions (${items.length})\n`;
  for (const inst of items) {
    const line = `- ${inst}\n`;
    if (out.length + line.length > limit) break;
    out += line;
  }
  return out;
}

const FORMATTERS = {
  decisions: formatDecisions,
  files: formatFiles,
  errors: formatErrors,
  todos: formatTodos,
  thinking: formatThinking,
  tools: formatTools,
  instructions: formatInstructions,
};

// ---------------------------------------------------------------------------
// Main recall
// ---------------------------------------------------------------------------

function recall(input) {
  const opts = parseArgs(input);
  const projectDir = getProjectRoot();
  const logs = findSessionLogs(projectDir);

  if (!logs.length) {
    return 'No session logs found for this project.';
  }

  // Exclude current session if identifiable
  const currentSession = process.env.CLAUDE_SESSION_ID;
  const candidates = currentSession
    ? logs.filter(l => l.sessionId !== currentSession)
    : logs.slice(1); // assume most recent is current

  const selected = candidates.slice(0, opts.sessions);
  if (!selected.length) {
    return 'No previous sessions found (only the current session exists).';
  }

  const budget = allocateBudget(opts.categories, opts.budget);
  const sections = [];

  for (const log of selected) {
    const date = new Date(log.mtime).toISOString().slice(0, 16).replace('T', ' ');
    const messages = parseTranscript(log.path);
    if (!messages.length) continue;

    const mined = mineAll(messages);
    let header = `## Session: ${log.sessionId.slice(0, 8)} (${date})`;
    const parts = [header];

    for (const cat of opts.categories) {
      const data = mined[cat];
      const formatter = FORMATTERS[cat];
      if (!formatter) continue;
      const limit = charBudget(budget[cat]);
      const formatted = formatter(data, limit);
      if (formatted) parts.push(formatted);
    }

    if (parts.length > 1) {
      sections.push(parts.join('\n'));
    }
  }

  if (!sections.length) {
    return 'Previous sessions found but no extractable content for the requested categories.';
  }

  return sections.join('\n---\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const input = process.argv.slice(2).join(' ');
const output = recall(input);
console.log(output);
