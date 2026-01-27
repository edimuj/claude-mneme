/**
 * Shared utilities for claude-mneme plugin
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { execFileSync, spawn } from 'child_process';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

export const MEMORY_BASE = join(homedir(), '.claude-mneme');
export const CONFIG_FILE = join(MEMORY_BASE, 'config.json');

/**
 * Get the project name from cwd
 * Uses git repo root name if available, otherwise directory name
 */
export function getProjectName(cwd = process.cwd()) {
  try {
    // Try to get git repo root using execFileSync (safer than execSync)
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return basename(gitRoot);
  } catch {
    // Not a git repo, use directory name
    return basename(cwd);
  }
}

/**
 * Get the project-specific memory directory
 */
export function getProjectMemoryDir(cwd = process.cwd()) {
  const projectName = getProjectName(cwd);
  // Sanitize project name for filesystem
  const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(MEMORY_BASE, 'projects', safeName);
}

/**
 * Ensure memory directories exist and return paths
 */
export function ensureMemoryDirs(cwd = process.cwd()) {
  const projectDir = getProjectMemoryDir(cwd);

  if (!existsSync(MEMORY_BASE)) {
    mkdirSync(MEMORY_BASE, { recursive: true });
  }

  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  return {
    base: MEMORY_BASE,
    project: projectDir,
    log: join(projectDir, 'log.jsonl'),
    summary: join(projectDir, 'summary.md'),
    remembered: join(projectDir, 'remembered.json'),
    lastSession: join(projectDir, '.last-session'),
    config: CONFIG_FILE
  };
}

/**
 * Load config with defaults
 */
export function loadConfig() {
  const defaultConfig = {
    maxLogEntriesBeforeSummarize: 50,
    keepRecentEntries: 10,
    maxResponseLength: 1000,
    summarizeResponses: true,
    maxSummarySentences: 4,
    actionWords: [
      'fixed', 'added', 'created', 'updated', 'removed', 'deleted',
      'implemented', 'refactored', 'changed', 'modified', 'resolved',
      'installed', 'configured', 'migrated', 'moved', 'renamed',
      'error', 'bug', 'issue', 'warning', 'failed', 'success',
      'complete', 'done', 'finished', 'ready'
    ],
    model: 'claude-haiku-4-20250514',
    claudePath: 'claude'
  };

  if (existsSync(CONFIG_FILE)) {
    try {
      return { ...defaultConfig, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) };
    } catch {
      return defaultConfig;
    }
  }
  return defaultConfig;
}

/**
 * Strip low-information lead-in sentences from the start of text.
 * e.g. "Here's a summary of what changed:" → removed
 *      "Let me explain the changes." → removed
 * Only removes when there is substantive content afterwards.
 */
export function stripLeadIns(text) {
  if (!text) return text;
  let result = text;

  // Case 1: First line is a short lead-in ending with ':' (sets up a list)
  const lines = result.split('\n');
  const firstLine = lines[0]?.trim() || '';
  if (firstLine.length < 80 && /:\s*$/.test(firstLine) && lines.length > 1) {
    const rest = lines.slice(1).join('\n').trim();
    if (rest) result = rest;
  }

  // Case 2: First sentence is meta-commentary ("Here's what I see.")
  const sentenceEnd = result.match(/^(.+?[.!?])\s+(.+)/s);
  if (sentenceEnd) {
    const first = sentenceEnd[1].trim();
    if (first.length < 80 && isLeadIn(first)) {
      result = sentenceEnd[2].trim();
    }
  }

  return result;
}

const LEAD_IN_RE = /^(?:here(?:'s| is| are)|let me|i'll |i will |i'm going to|now,? let me|so,? here|ok(?:ay)?,? (?:so|let|here|now))/i;

function isLeadIn(sentence) {
  return LEAD_IN_RE.test(sentence);
}

/**
 * Split text into logical units (sentences, paragraphs, bullet items)
 * Handles markdown formatting, bullet lists, and paragraph breaks
 */
export function splitSentences(text) {
  const units = [];

  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());

  for (const para of paragraphs) {
    const lines = para.split('\n').map(l => l.trim()).filter(l => l);
    const isBulletList = lines.every(l => /^[-*•]\s/.test(l) || l === '');

    if (isBulletList) {
      for (const line of lines) {
        const content = line.replace(/^[-*•]\s+/, '').trim();
        if (content) units.push(content);
      }
    } else {
      const normalized = para.replace(/\s+/g, ' ').trim();
      const sentences = normalized.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(s => s.trim());
      if (sentences.length > 0) {
        units.push(...sentences);
      } else if (normalized) {
        units.push(normalized);
      }
    }
  }

  if (units.length === 0 && text.trim()) {
    units.push(text.replace(/\s+/g, ' ').trim());
  }

  return units;
}

/**
 * Score a sentence based on action word matches
 */
function scoreSentence(sentence, actionWords) {
  const lower = sentence.toLowerCase();
  let score = 0;
  for (const word of actionWords) {
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(lower)) score += 1;
  }
  return score;
}

/**
 * Extractive summarization using action words.
 * Strips lead-ins, splits into sentences, scores by action words,
 * returns top N sentences in original order.
 */
export function extractiveSummarize(text, config) {
  const cleaned = stripLeadIns(text);
  const sentences = splitSentences(cleaned);

  if (sentences.length === 0) return text;
  if (sentences.length <= config.maxSummarySentences) return sentences.join(' ');

  const actionWords = config.actionWords || [];

  // Score all sentences
  const scored = sentences.map((sentence, index) => ({
    sentence,
    index,
    score: scoreSentence(sentence, actionWords)
  }));

  // Sort by score descending, then by position
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  // Take top N
  const top = scored.slice(0, config.maxSummarySentences);

  // Restore original order
  top.sort((a, b) => a.index - b.index);

  return top.map(s => s.sentence).join(' ');
}

/**
 * Format a structured log entry for display
 * Used by session-start.mjs to render entries with localized timestamps
 */
export function formatEntry(entry) {
  const ts = localTime(entry.ts);
  return `[${ts}] ${formatEntryBrief(entry)}`;
}

function localTime(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    });
  } catch {
    return ts;
  }
}

/**
 * Format an entry without timestamp (for use inside grouped summaries)
 */
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
    case 'task':
      // New format has action/subject, old format has content
      return entry.action ? `Task ${entry.action}: ${entry.subject}` : `Task: ${c}`;
    case 'commit':
      return `Commit: ${stripPrefix(c, 'Git commit: ')}`;
    default:
      return `(${entry.type}) ${c}`;
  }
}

function stripPrefix(str, prefix) {
  if (typeof prefix === 'string') {
    return str.startsWith(prefix) ? str.slice(prefix.length) : str;
  }
  // regex
  return str.replace(prefix, '');
}

/**
 * Format JSONL lines grouped by local date for summarization prompts.
 * Returns a string with date headers and bullet-listed entries.
 */
export function formatEntriesForSummary(lines) {
  const entries = lines.map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);

  if (entries.length === 0) return '';

  // Group by local date
  const groups = new Map();
  for (const entry of entries) {
    const dayKey = new Date(entry.ts).toLocaleDateString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
    });
    if (!groups.has(dayKey)) groups.set(dayKey, []);
    groups.get(dayKey).push(entry);
  }

  const sections = [];
  for (const [day, dayEntries] of groups) {
    const items = dayEntries.map(e => `- ${formatEntryBrief(e)}`).join('\n');
    sections.push(`### ${day}\n${items}`);
  }

  return sections.join('\n\n');
}

/**
 * Check if summarization is needed and spawn it in background if so
 * Call this after appending to the log
 */
export function maybeSummarize(cwd = process.cwd()) {
  const paths = ensureMemoryDirs(cwd);
  const config = loadConfig();

  // Quick check: does log exist and have enough entries?
  if (!existsSync(paths.log)) {
    return;
  }

  try {
    const logContent = readFileSync(paths.log, 'utf-8').trim();
    if (!logContent) return;

    const entryCount = logContent.split('\n').filter(l => l).length;

    if (entryCount < config.maxLogEntriesBeforeSummarize) {
      return;
    }

    // Check for existing lock (avoid spawning if already running)
    const lockFile = paths.log + '.lock';
    if (existsSync(lockFile)) {
      const lockContent = readFileSync(lockFile, 'utf-8').trim();
      const lockTime = parseInt(lockContent, 10);
      if (lockTime && Date.now() - lockTime < 5 * 60 * 1000) {
        // Lock is fresh, summarization already running
        return;
      }
    }

    // Spawn summarize.mjs in background
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const summarizeScript = join(__dirname, 'summarize.mjs');

    const child = spawn('node', [summarizeScript, cwd], {
      detached: true,
      stdio: 'ignore',
      cwd: cwd
    });

    child.unref();
  } catch {
    // Silent fail - don't block the calling script
  }
}
