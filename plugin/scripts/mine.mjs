import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// ---------------------------------------------------------------------------
// JSONL session log discovery
// ---------------------------------------------------------------------------

const MIN_SESSION_SIZE = 100_000; // skip subagent sessions (<100KB)

export function findSessionLogs(projectDir, { minSize = MIN_SESSION_SIZE } = {}) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, '.claude');
  const projectsDir = join(configDir, 'projects');

  const safeName = projectDir.replace(/^\//, '-').replace(/\//g, '-');
  const logDir = join(projectsDir, safeName);

  try {
    return readdirSync(logDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = join(logDir, f);
        const stat = statSync(full);
        return { path: full, sessionId: f.replace('.jsonl', ''), mtime: stat.mtimeMs, size: stat.size };
      })
      .filter(l => l.size >= minSize)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// JSONL parsing (streaming-friendly, line-by-line)
// ---------------------------------------------------------------------------

export function parseTranscript(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8').trim();
    if (!content) return [];
    const messages = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return messages;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Message-level miners
// ---------------------------------------------------------------------------

export function mineFiles(messages) {
  const files = new Map(); // path → { actions: Set, count }
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const { name, input } = block;
      let path, action;
      if (name === 'Read') { path = input?.file_path; action = 'read'; }
      else if (name === 'Write') { path = input?.file_path; action = 'write'; }
      else if (name === 'Edit') { path = input?.file_path; action = 'edit'; }
      else if (name === 'Glob') continue;
      else if (name === 'Bash') {
        const cmd = input?.command || '';
        const gitMatch = cmd.match(/git\s+(?:add|rm|mv)\s+(.+)/);
        if (gitMatch) { path = gitMatch[1].split(/\s+/)[0]; action = 'git'; }
      }
      if (!path) continue;
      const short = shortenPath(path);
      const entry = files.get(short) || { actions: new Set(), count: 0 };
      entry.actions.add(action);
      entry.count++;
      files.set(short, entry);
    }
  }
  return [...files.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([path, { actions, count }]) => ({
      path,
      actions: [...actions],
      count,
    }));
}

export function mineToolCalls(messages) {
  const counts = new Map();
  const sequence = [];
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const name = block.name;
      counts.set(name, (counts.get(name) || 0) + 1);
      sequence.push(name);
    }
  }
  const total = sequence.length;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { total, counts: sorted, sequence };
}

export function mineThinking(messages) {
  const blocks = [];
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'thinking') continue;
      const text = block.thinking || '';
      if (text.length < 50) continue;
      const firstLine = text.trim().split('\n')[0].slice(0, 150);
      blocks.push({ summary: firstLine, length: text.length });
    }
  }
  return blocks;
}

export function mineErrors(messages) {
  const errors = [];
  const seen = new Set();

  // Build a map of tool_use_id → tool_name for context
  const toolNames = new Map();
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use' && block.id) {
        toolNames.set(block.id, block.name);
      }
    }
  }

  for (const msg of messages) {
    if (msg.type !== 'user') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;

      const rawText = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
          : '';

      // Only keep actual errors: is_error flag, or exit code > 0, or clear error patterns
      const isExplicitError = block.is_error === true;
      const hasExitCode = /^Exit code [1-9]/m.test(rawText);
      const hasErrorPattern = /^(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|ENOENT|EACCES|EPERM|fatal:)\b/m.test(rawText);
      const hasToolError = /<tool_use_error>/i.test(rawText);

      if (!isExplicitError && !hasExitCode && !hasErrorPattern && !hasToolError) continue;

      const text = rawText.slice(0, 300);
      if (!text || text.length < 10) continue;

      const tool = toolNames.get(block.tool_use_id) || 'unknown';
      const firstLine = text.split('\n')[0].trim();
      const key = `${tool}:${firstLine.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      errors.push({ text: text.trim(), tool });
    }
  }
  return errors;
}

export function mineDecisions(messages) {
  const decisions = [];
  const seen = new Set();
  const patterns = [
    /(?:decided|choosing|going with|selected|picked|will use|opted for)\s+(.{10,120})/gi,
    /(?:the approach|the solution|the plan) (?:is|will be)\s+(.{10,120})/gi,
    /(?:let's|we'll|I'll)\s+(?:go with|use|implement|build|create)\s+(.{10,120})/gi,
  ];
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    const text = extractText(msg.message?.content);
    if (!text) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const d = match[1].trim().replace(/[.,:;]$/, '');
        if (d.length > 10 && !seen.has(d)) {
          seen.add(d);
          decisions.push(d);
        }
      }
    }
  }
  return decisions;
}

export function mineTodos(messages) {
  const todos = [];
  const seen = new Set();
  const patterns = [
    /(?:TODO|FIXME|HACK|XXX):\s*(.{10,100})/gi,
    /(?:we |you |I )?(?:need to|should|must|have to)\s+((?:add|fix|update|create|remove|implement|refactor|change|move|rename|delete|migrate|test|check|verify|ensure|resolve|handle|configure|set up|clean up)\b.{5,100})/gi,
    /(?:next step|action item|follow.?up):\s*(.{10,100})/gi,
  ];
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    const text = extractText(msg.message?.content);
    if (!text) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const t = match[1].trim().replace(/[.,:;]$/, '');
        if (t.length > 10 && !seen.has(t)) {
          seen.add(t);
          todos.push(t);
        }
      }
    }
  }
  return todos;
}

export function mineInstructions(messages) {
  const instructions = [];
  const instructionPatterns = [
    /(?:don't|do not|never|always|stop|please)\s+(.{10,120})/gi,
    /(?:use .+ instead of|prefer .+ over|switch to)\s*(.{5,120})/gi,
    /(?:from now on|going forward|in the future)\s*[,:]?\s*(.{10,120})/gi,
    /(?:remember|keep in mind|note that)\s*:?\s*(.{10,120})/gi,
  ];
  for (const msg of messages) {
    if (msg.type !== 'user') continue;
    const text = extractText(msg.message?.content);
    if (!text || text.length > 500) continue;
    // Skip system-injected content (hook output, system reminders, skill loads)
    if (text.includes('<system-reminder>') || text.includes('CLAUDE_PLUGIN_ROOT')
        || text.includes('<local-command') || text.includes('Base directory for this skill')) continue;
    for (const pattern of instructionPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const inst = match[0].trim().replace(/[.,:;]$/, '');
        if (inst.length > 10) {
          instructions.push(inst);
        }
      }
    }
  }
  return instructions;
}

// ---------------------------------------------------------------------------
// Full mining: extract all categories from messages
// ---------------------------------------------------------------------------

export function mineAll(messages) {
  return {
    files: mineFiles(messages),
    decisions: mineDecisions(messages),
    errors: mineErrors(messages),
    todos: mineTodos(messages),
    thinking: mineThinking(messages),
    tools: mineToolCalls(messages),
    instructions: mineInstructions(messages),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

function shortenPath(p) {
  if (!p) return p;
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) {
    p = '~' + p.slice(home.length);
  }
  const cwd = process.cwd();
  if (p.startsWith(cwd + '/')) {
    p = p.slice(cwd.length + 1);
  }
  return p;
}
