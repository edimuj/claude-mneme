/**
 * Shared utilities for claude-mneme plugin
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, statSync, unlinkSync, renameSync, openSync, closeSync, writeSync, constants as fsConstants } from 'fs';
import { execFileSync, spawn } from 'child_process';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

export const MEMORY_BASE = join(homedir(), '.claude-mneme');
export const CONFIG_FILE = join(MEMORY_BASE, 'config.json');

/**
 * Escape a string for use inside an XML/HTML attribute value.
 */
export function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
    summaryJson: join(projectDir, 'summary.json'),
    remembered: join(projectDir, 'remembered.json'),
    entities: join(projectDir, 'entities.json'),
    cache: join(projectDir, '.cache.json'),
    lastSession: join(projectDir, '.last-session'),
    config: CONFIG_FILE
  };
}

/**
 * Acquire a file lock using O_EXCL, run fn, then release.
 * If the lock is held by another process, returns undefined without running fn.
 * Stale locks (older than staleSec) are automatically broken.
 */
export function withFileLock(lockPath, fn, staleSec = 10) {
  try {
    const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    writeSync(fd, Buffer.from(process.pid.toString()));
    closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Lock exists — check if stale
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > staleSec * 1000) {
        unlinkSync(lockPath);
        // Retry once
        const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
        writeSync(fd, Buffer.from(process.pid.toString()));
        closeSync(fd);
      } else {
        return undefined; // Lock held, skip
      }
    } catch {
      return undefined; // Can't break stale lock or lost retry race, skip
    }
  }

  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch {}
  }
}

/**
 * Get file modification time, or 0 if file doesn't exist
 */
function getFileMtime(filePath) {
  try {
    if (existsSync(filePath)) {
      return statSync(filePath).mtimeMs;
    }
  } catch {}
  return 0;
}

/**
 * Read and cache parsed data from JSON files
 * Uses file mtime to validate cache freshness
 *
 * @param {string} cwd - Working directory
 * @param {object} config - Config object
 * @returns {object} Cached data { summary, remembered, logEntries, entities }
 */
export function readCachedData(cwd = process.cwd(), config = {}) {
  const paths = ensureMemoryDirs(cwd);
  const cacheConfig = config.caching || {};

  if (cacheConfig.enabled === false) {
    return readFreshData(paths);
  }

  const maxAgeMs = (cacheConfig.maxAgeSeconds || 60) * 1000;

  // Check if cache exists and is fresh
  if (existsSync(paths.cache)) {
    try {
      const cache = JSON.parse(readFileSync(paths.cache, 'utf-8'));
      const cacheAge = Date.now() - (cache.cachedAt || 0);

      // Validate cache: check age and source file mtimes
      if (cacheAge < maxAgeMs) {
        const summaryMtime = getFileMtime(paths.summaryJson);
        const rememberedMtime = getFileMtime(paths.remembered);
        const logMtime = getFileMtime(paths.log);
        const entitiesMtime = getFileMtime(paths.entities);

        const mtimesMatch =
          cache.mtimes?.summary === summaryMtime &&
          cache.mtimes?.remembered === rememberedMtime &&
          cache.mtimes?.log === logMtime &&
          cache.mtimes?.entities === entitiesMtime;

        if (mtimesMatch) {
          return cache.data;
        }
      }
    } catch {
      // Cache read failed, fall through to fresh read
    }
  }

  // Cache miss or invalid - read fresh and update cache
  const freshData = readFreshData(paths);

  // Write cache
  try {
    const cache = {
      cachedAt: Date.now(),
      mtimes: {
        summary: getFileMtime(paths.summaryJson),
        remembered: getFileMtime(paths.remembered),
        log: getFileMtime(paths.log),
        entities: getFileMtime(paths.entities)
      },
      data: freshData
    };
    writeFileSync(paths.cache, JSON.stringify(cache));
  } catch {
    // Cache write failed, continue without caching
  }

  return freshData;
}

/**
 * Read fresh data from source files (no caching)
 */
function readFreshData(paths) {
  const result = {
    summary: null,
    remembered: [],
    logEntries: [],
    entities: null
  };

  // Read summary
  if (existsSync(paths.summaryJson)) {
    try {
      result.summary = JSON.parse(readFileSync(paths.summaryJson, 'utf-8'));
    } catch (e) {
      logError(e, 'readFreshData:summary.json');
    }
  }

  // Read remembered
  if (existsSync(paths.remembered)) {
    try {
      result.remembered = JSON.parse(readFileSync(paths.remembered, 'utf-8'));
    } catch (e) {
      logError(e, 'readFreshData:remembered.json');
    }
  }

  // Read and parse log entries
  if (existsSync(paths.log)) {
    try {
      const content = readFileSync(paths.log, 'utf-8').trim();
      if (content) {
        result.logEntries = content.split('\n')
          .filter(l => l)
          .map(line => {
            try { return JSON.parse(line); }
            catch { return null; }
          })
          .filter(Boolean);
      }
    } catch (e) {
      logError(e, 'readFreshData:log.jsonl');
    }
  }

  // Read entities
  if (existsSync(paths.entities)) {
    try {
      result.entities = JSON.parse(readFileSync(paths.entities, 'utf-8'));
    } catch (e) {
      logError(e, 'readFreshData:entities.json');
    }
  }

  return result;
}

/**
 * Invalidate cache (call after writes)
 */
export function invalidateCache(cwd = process.cwd()) {
  const paths = ensureMemoryDirs(cwd);
  try {
    if (existsSync(paths.cache)) {
      writeFileSync(paths.cache, '{}');
    }
  } catch (e) {
    logError(e, 'invalidateCache');
  }
}

/**
 * Recursively merge source into target, preserving nested default keys.
 * Arrays and non-plain-object values from source replace target entirely.
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Load config with defaults (cached per process)
 */
let _cachedConfig = null;
export function loadConfig() {
  if (_cachedConfig) return _cachedConfig;

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
    claudePath: 'claude',

    // PreCompact hook configuration
    preCompact: {
      enabled: true,                    // Enable/disable PreCompact hook
      triggers: ['auto', 'manual'],     // Which triggers to respond to
      flushPending: true,               // Flush pending log entries
      forceSummarize: true,             // Force immediate summarization
      extractContext: true,             // Extract context from transcript
      saveSnapshot: false,              // Save full transcript snapshot
      extraction: {
        enabled: true,
        maxItems: 10,                   // Max items per category
        categories: {
          decisions: true,              // Extract decisions/choices made
          files: true,                  // Extract file paths mentioned
          errors: true,                 // Extract errors encountered
          todos: true,                  // Extract TODOs/action items
          keyPoints: true               // Extract key discussion points
        }
      }
    },

    // PostCompact hook configuration (injects extracted context after compaction)
    postCompact: {
      enabled: true,                    // Enable/disable context injection
      maxAgeMinutes: 5,                 // Only inject if extraction is this recent
      maxFiles: 10,                     // Max file paths to inject
      categories: {
        keyPoints: true,                // Inject key discussion points
        decisions: true,                // Inject decisions made
        files: true,                    // Inject file paths
        errors: true,                   // Inject errors encountered
        todos: true                     // Inject pending items
      }
    },

    // Relevance-based injection configuration
    relevanceScoring: {
      enabled: true,                    // Enable/disable relevance scoring
      maxEntries: 10,                   // Max entries to inject after scoring
      weights: {
        recency: 0.4,                   // Weight for time decay (0-1)
        fileRelevance: 0.35,            // Weight for file path matching (0-1)
        typePriority: 0.25              // Weight for entry type priority (0-1)
      },
      typePriorities: {                 // Priority scores by entry type (higher = more important)
        commit: 1.0,
        task: 0.9,
        agent: 0.8,
        prompt: 0.5,
        response: 0.3,
        compact: 0.4
      },
      recencyHalfLifeHours: 24          // Hours until recency score drops to 50%
    },

    // Entity extraction and indexing configuration
    entityExtraction: {
      enabled: true,                    // Enable/disable entity extraction
      maxContextsPerEntity: 5,          // Max contexts to keep per entity
      categories: {
        files: true,                    // Extract file paths
        functions: true,                // Extract function/method names
        errors: true,                   // Extract error messages
        packages: true                  // Extract package names
      },
      // File extension filter - only index files with these extensions
      fileExtensions: ['js', 'ts', 'jsx', 'tsx', 'mjs', 'py', 'rb', 'go', 'rs', 'java', 'cpp', 'c', 'h', 'css', 'scss', 'html', 'vue', 'svelte', 'json', 'yaml', 'yml', 'md', 'sql'],
      // Minimum entity name length to index
      minEntityLength: 2,
      // Enable entity-based relevance boost
      useInRelevanceScoring: true,
      // Remove entities not seen in this many days (0 = never prune)
      maxAgeDays: 30
    },

    // Semantic deduplication configuration
    deduplication: {
      enabled: true,                    // Enable/disable deduplication
      timeWindowMinutes: 5,             // Group entries within this time window
      typePriority: {                   // Higher = more signal (kept over lower)
        commit: 100,
        task: 80,
        agent: 70,
        prompt: 40,
        response: 30,
        compact: 20
      },
      mergeContext: true                // Include context from dropped entries in kept entry
    },

    // Outcome tracking configuration
    outcomeTracking: {
      enabled: true,                    // Enable/disable outcome tracking
      outcomePriority: {                // Score multiplier for task outcomes (0-1)
        completed: 1.0,                 // Completed tasks are highest signal
        in_progress: 0.7,               // In-progress tasks are medium signal
        abandoned: 0.3                  // Abandoned tasks are low signal (but not zero)
      },
      trackDuration: true               // Track how long tasks took
    },

    // File caching configuration
    caching: {
      enabled: true,                    // Enable/disable file caching
      maxAgeSeconds: 60                 // Cache validity in seconds
    },

    // Sync server configuration (optional)
    sync: {
      enabled: false,                   // Local-only by default
      serverUrl: null,                  // e.g., "http://localhost:3847"
      apiKey: null,                     // Optional authentication
      projectId: null,                  // Override auto-detected project name
      timeoutMs: 10000,                 // Request timeout
      retries: 3                        // Retry count on failure
    },

    // Hierarchical context injection configuration
    contextInjection: {
      enabled: true,                    // Enable hierarchical injection
      sections: {
        // High priority - always inject
        projectContext: { enabled: true, priority: 'high' },
        keyDecisions: { enabled: true, priority: 'high', maxItems: 10 },
        currentState: { enabled: true, priority: 'high', maxItems: 10 },
        remembered: { enabled: true, priority: 'high' },
        // Medium priority - inject if relevant/recent
        recentWork: { enabled: true, priority: 'medium', maxItems: 5, maxAgeDays: 7 },
        gitChanges: { enabled: true, priority: 'medium' },
        activeEntities: { enabled: true, priority: 'medium', maxFiles: 5, maxFunctions: 5 },
        // Low priority - minimal injection
        recentEntries: { enabled: true, priority: 'low', maxItems: 4 }
      },
      // When context budget is limited, drop low priority first
      budgetMode: 'adaptive'           // 'adaptive' | 'strict' | 'full'
    }
  };

  let config = defaultConfig;
  if (existsSync(CONFIG_FILE)) {
    try {
      config = deepMerge(defaultConfig, JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')));
    } catch (e) {
      logError(e, 'loadConfig:config.json');
    }
  }

  // Resolve claudePath to absolute path if it's a bare command name.
  // The claude-agent-sdk requires an absolute path, not a PATH lookup.
  if (config.claudePath && !config.claudePath.startsWith('/')) {
    try {
      const resolved = execFileSync('which', [config.claudePath], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (resolved) {
        config.claudePath = resolved;
      }
    } catch {
      // 'which' failed — keep original value, will fail later with a clear error
    }
  }

  _cachedConfig = config;
  return config;
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
 * Score a sentence based on action word matches.
 * Uses a single pre-compiled regex for all action words.
 */
const _actionWordRegexCache = new Map();
function getActionWordRegex(actionWords) {
  const key = actionWords.join('|');
  if (!_actionWordRegexCache.has(key)) {
    const alternation = actionWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    _actionWordRegexCache.set(key, new RegExp(`\\b(?:${alternation})\\b`, 'gi'));
  }
  return _actionWordRegexCache.get(key);
}

function scoreSentence(sentence, actionWords) {
  const regex = getActionWordRegex(actionWords);
  regex.lastIndex = 0;
  const matches = sentence.match(regex);
  return matches ? matches.length : 0;
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
  let text = `[${ts}] ${formatEntryBrief(entry)}`;

  // If this entry was deduplicated and has merged context, show it
  if (entry._mergedFrom && entry._mergedFrom.length > 0) {
    text += ` (also: ${entry._mergedFrom.join(', ')})`;
  }

  return text;
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
    case 'task': {
      // New format has action/subject/outcome, old format has content
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
 * Default empty structured summary
 */
export function emptyStructuredSummary() {
  return {
    projectContext: '',
    keyDecisions: [],
    currentState: [],
    recentWork: [],
    lastUpdated: null
  };
}

/**
 * Render structured summary JSON to markdown for session injection
 * Supports hierarchical rendering with configurable sections
 *
 * @param {object} summary - Structured summary object
 * @param {string} projectName - Project name
 * @param {object} options - Rendering options from contextInjection config
 * @returns {object} { high: string, medium: string } - Separated by priority
 */
export function renderSummaryToMarkdown(summary, projectName, options = {}) {
  const sections = options.sections || {};
  const highLines = ['# Claude Memory Summary'];
  const mediumLines = [];

  if (summary.lastUpdated) {
    const ts = new Date(summary.lastUpdated).toISOString().replace('T', ' ').split('.')[0] + ' UTC';
    highLines.push(`\n*Last updated: ${ts}*`);
  }

  // Project Context - HIGH priority
  const pcConfig = sections.projectContext || { enabled: true };
  if (pcConfig.enabled !== false && summary.projectContext) {
    highLines.push('\n## Project Context');
    highLines.push(summary.projectContext);
  }

  // Key Decisions - HIGH priority
  const kdConfig = sections.keyDecisions || { enabled: true, maxItems: 10 };
  if (kdConfig.enabled !== false && summary.keyDecisions?.length > 0) {
    const maxItems = kdConfig.maxItems || 10;
    const decisions = summary.keyDecisions.slice(-maxItems); // Keep most recent
    highLines.push('\n## Key Decisions');
    for (const d of decisions) {
      const reason = d.reason ? ` — ${d.reason}` : '';
      highLines.push(`- **${d.decision}**${reason}`);
    }
  }

  // Current State - HIGH priority
  const csConfig = sections.currentState || { enabled: true, maxItems: 10 };
  if (csConfig.enabled !== false && summary.currentState?.length > 0) {
    const maxItems = csConfig.maxItems || 10;
    const states = summary.currentState.slice(0, maxItems);
    highLines.push('\n## Current State');
    for (const s of states) {
      highLines.push(`- **${s.topic}**: ${s.status}`);
    }
  }

  // Recent Work - MEDIUM priority (filter by recency)
  const rwConfig = sections.recentWork || { enabled: true, maxItems: 5, maxAgeDays: 7 };
  if (rwConfig.enabled !== false && summary.recentWork?.length > 0) {
    const maxItems = rwConfig.maxItems || 5;
    const maxAgeDays = rwConfig.maxAgeDays || 7;
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

    // Filter by recency and limit
    const recentWork = summary.recentWork
      .filter(w => {
        if (!w.date) return true; // Include undated items
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

  // Return both priority levels separately for flexible injection
  return {
    high: highLines.join('\n'),
    medium: mediumLines.join('\n'),
    full: highLines.concat(mediumLines).join('\n')
  };
}

/**
 * Legacy wrapper for backward compatibility
 */
export function renderSummaryFull(summary, projectName) {
  const result = renderSummaryToMarkdown(summary, projectName, {});
  return result.full;
}

/**
 * Extract file paths from entry content
 */
function extractFilePaths(entry, config = {}) {
  const content = entry.content || entry.subject || '';
  const paths = [];
  const allowedExtensions = config.fileExtensions || [
    'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'cpp', 'c', 'h',
    'css', 'scss', 'sass', 'less', 'html', 'vue', 'svelte', 'json', 'yaml', 'yml', 'md',
    'sql', 'sh', 'bash', 'zsh', 'toml', 'xml', 'graphql', 'prisma'
  ];
  const minLength = config.minEntityLength || 2;

  // Match common file path patterns - require path-like structure
  const patterns = [
    // Paths with directory separators
    /(?:^|[\s"'`])([a-zA-Z0-9_\-.]+\/[a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})(?:[\s"'`:]|$)/g,
    // Files explicitly mentioned after keywords
    /(?:file|in|from|to|edit|read|write|created|updated|modified)\s+[`"']?([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})[`"']?/gi,
    // Backtick-wrapped files
    /`([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g,
    // Standalone filenames with common extensions (stricter - must have recognizable pattern)
    /(?:^|[\s"'`])([a-zA-Z][a-zA-Z0-9_\-]*\.(?:ts|js|tsx|jsx|mjs|py|go|rs|java|vue|svelte|md|json|yaml|yml))(?:[\s"'`:]|$)/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const path = match[1];
      if (path && path.length >= minLength && path.length < 100 && !paths.includes(path)) {
        // Must have a recognizable extension
        const ext = path.split('.').pop()?.toLowerCase();
        if (ext && allowedExtensions.includes(ext)) {
          // Exclude common false positives
          if (!isFileFalsePositive(path)) {
            paths.push(path);
          }
        }
      }
    }
  }

  return paths;
}

/**
 * Check if a matched path is a false positive
 */
function isFileFalsePositive(path) {
  const lower = path.toLowerCase();
  // Exclude version numbers (1.0.0.js), URLs (http://), etc.
  if (/^\d+\.\d+/.test(path)) return true;
  if (lower.startsWith('http') || lower.startsWith('www.')) return true;
  // Exclude common words that match file patterns
  const falsePositives = ['property', 'of.undefined', 'read.property'];
  return falsePositives.some(fp => lower.includes(fp));
}

/**
 * Extract function/method names from entry content
 */
function extractFunctionNames(entry, config = {}) {
  const content = entry.content || entry.subject || '';
  const functions = [];
  const minLength = config.minEntityLength || 3; // Functions should be at least 3 chars

  // Match function patterns - be more conservative
  const patterns = [
    // Function declarations with clear syntax
    /(?:function|const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]{2,})\s*(?:=\s*(?:async\s*)?\(|=\s*(?:async\s*)?function|\()/g,
    // Backtick-wrapped function calls (common in docs/messages)
    /`([a-zA-Z_$][a-zA-Z0-9_$]{2,})\s*\(`/g,
    /`([a-zA-Z_$][a-zA-Z0-9_$]{2,})\(\)`/g,
    // "the handleX function", "method handleX" - requires camelCase or snake_case
    /(?:function|method|handler|callback)\s+[`"']?([a-zA-Z_$][a-zA-Z0-9_$]*[A-Z_][a-zA-Z0-9_$]*)[`"']?/gi,
    // Python: def name( - must have decent length
    /def\s+([a-zA-Z_][a-zA-Z0-9_]{2,})\s*\(/g,
  ];

  // Common false positives to exclude (expand the list)
  const exclude = new Set([
    // Keywords
    'if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'break', 'continue',
    'new', 'typeof', 'instanceof', 'delete', 'void', 'throw', 'try', 'finally',
    'import', 'export', 'from', 'require', 'module', 'default', 'case',
    'class', 'extends', 'constructor', 'super', 'this', 'self', 'static',
    'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
    'async', 'await', 'yield', 'let', 'const', 'var', 'function',
    // Built-in objects
    'console', 'window', 'document', 'process', 'global', 'module', 'exports',
    'Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON',
    'Promise', 'Error', 'Map', 'Set', 'RegExp', 'Function', 'Symbol', 'BigInt',
    'Buffer', 'Uint8Array', 'ArrayBuffer', 'DataView', 'Proxy', 'Reflect',
    // Common methods (too generic)
    'get', 'set', 'has', 'add', 'delete', 'clear', 'keys', 'values', 'entries',
    'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race', 'any',
    'log', 'error', 'warn', 'info', 'debug', 'trace', 'assert', 'dir', 'table',
    'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'flat',
    'map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every', 'includes', 'sort',
    'length', 'size', 'indexOf', 'lastIndexOf', 'replace', 'split', 'trim', 'match',
    'toString', 'valueOf', 'toJSON', 'toLocaleString', 'parse', 'stringify',
    'read', 'write', 'open', 'close', 'send', 'receive', 'emit', 'on', 'off',
    'start', 'stop', 'run', 'exec', 'call', 'apply', 'bind', 'create', 'destroy',
    'init', 'setup', 'cleanup', 'reset', 'update', 'render', 'mount', 'unmount',
    // Common short words that aren't useful
    'was', 'the', 'not', 'and', 'for', 'are', 'but', 'can', 'has', 'had', 'did',
    'use', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  ]);

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (name && name.length >= minLength && name.length < 50 &&
          !functions.includes(name) && !exclude.has(name) && !exclude.has(name.toLowerCase())) {
        // Additional check: should look like a real function name (has mixed case or underscore)
        if (/[A-Z]/.test(name) || name.includes('_') || name.length >= 6) {
          functions.push(name);
        }
      }
    }
  }

  return functions;
}

/**
 * Extract error messages from entry content
 */
function extractErrorMessages(entry, config = {}) {
  const content = entry.content || entry.subject || '';
  const errors = [];
  const minLength = config.minEntityLength || 2;

  // Match error patterns
  const patterns = [
    // Standard error types
    /\b((?:Type|Reference|Syntax|Range|URI|Eval|Internal|Aggregate)?Error):\s*([^\n.]{5,100})/g,
    // Exception patterns
    /\b(Exception|Fault):\s*([^\n.]{5,100})/gi,
    // "error:" prefix
    /\berror:\s*([^\n.]{5,80})/gi,
    // "failed:" or "failure:"
    /\b(?:failed|failure):\s*([^\n.]{5,80})/gi,
    // Stack trace first line
    /^\s*at\s+([^\n]{10,100})/gm,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      // Combine error type and message if both captured
      const errorMsg = match[2] ? `${match[1]}: ${match[2]}` : match[1];
      const cleaned = errorMsg.trim().slice(0, 100); // Cap at 100 chars
      if (cleaned.length >= minLength && !errors.includes(cleaned)) {
        errors.push(cleaned);
      }
    }
  }

  return errors;
}

/**
 * Extract package/module names from entry content
 */
function extractPackageNames(entry, config = {}) {
  const content = entry.content || entry.subject || '';
  const packages = [];
  const minLength = config.minEntityLength || 2;

  // First, extract multi-package install commands
  const installMatch = content.match(/(?:npm|yarn|pnpm)\s+(?:install|add|i)\s+([^\n.]+)/gi);
  if (installMatch) {
    for (const cmd of installMatch) {
      // Extract all packages from the command (space-separated after the verb)
      const pkgPart = cmd.replace(/^(?:npm|yarn|pnpm)\s+(?:install|add|i)\s+/i, '');
      const pkgNames = pkgPart.split(/\s+/).filter(p => p && !p.startsWith('-'));
      for (let name of pkgNames) {
        // Strip version specifier but keep scope
        name = name.replace(/@[\d^~>=<.*]+$/, '');
        if (isValidPackageName(name, minLength)) {
          if (!packages.includes(name)) packages.push(name);
        }
      }
    }
  }

  // Additional patterns for imports/requires
  const patterns = [
    // import from '@scope/package' or 'package'
    /(?:import|from)\s+['"](@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)['"]/g,
    /(?:import|from)\s+['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g,
    // require('@scope/package') or require('package')
    /require\s*\(\s*['"](@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]\s*\)/g,
    // pip install
    /pip\s+install\s+([a-zA-Z][a-zA-Z0-9_-]*)/g,
    // Scoped package names in backticks
    /`(@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)`/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      let name = match[1];
      // Strip version specifier
      name = name.replace(/@[\d^~>=<.*]+$/, '');
      if (isValidPackageName(name, minLength) && !packages.includes(name)) {
        packages.push(name);
      }
    }
  }

  return packages;
}

/**
 * Check if a string is a valid package name
 */
function isValidPackageName(name, minLength = 2) {
  if (!name || name.length < minLength || name.length >= 60) return false;
  if (name.startsWith('./') || name.startsWith('../') || name.startsWith('/')) return false;

  // Node.js built-in modules to exclude
  const exclude = new Set([
    'fs', 'path', 'os', 'util', 'http', 'https', 'net', 'url', 'crypto',
    'stream', 'events', 'buffer', 'child_process', 'cluster', 'dgram',
    'dns', 'domain', 'readline', 'repl', 'tls', 'tty', 'v8', 'vm', 'zlib',
    'assert', 'async_hooks', 'console', 'constants', 'perf_hooks', 'process',
    'querystring', 'string_decoder', 'timers', 'worker_threads', 'inspector',
    'module', 'punycode', 'sys', 'wasi',
    // Common relative imports that slip through
    'src', 'lib', 'dist', 'build', 'test', 'tests', 'spec', 'utils', 'helpers',
    'components', 'pages', 'hooks', 'services', 'models', 'types', 'interfaces',
  ]);

  return !exclude.has(name);
}

/**
 * Extract all entities from an entry
 * @param {object} entry - Log entry
 * @param {object} config - Entity extraction config
 * @returns {object} Extracted entities by category
 */
export function extractEntitiesFromEntry(entry, config = {}) {
  const categories = config.categories || { files: true, functions: true, errors: true, packages: true };
  const result = {};

  if (categories.files !== false) {
    const files = extractFilePaths(entry, config);
    if (files.length > 0) result.files = files;
  }

  if (categories.functions !== false) {
    const functions = extractFunctionNames(entry, config);
    if (functions.length > 0) result.functions = functions;
  }

  if (categories.errors !== false) {
    const errors = extractErrorMessages(entry, config);
    if (errors.length > 0) result.errors = errors;
  }

  if (categories.packages !== false) {
    const packages = extractPackageNames(entry, config);
    if (packages.length > 0) result.packages = packages;
  }

  return result;
}

/**
 * Load entity index from file
 */
export function loadEntityIndex(cwd = process.cwd()) {
  const paths = ensureMemoryDirs(cwd);
  if (existsSync(paths.entities)) {
    try {
      return JSON.parse(readFileSync(paths.entities, 'utf-8'));
    } catch (e) {
      logError(e, 'loadEntityIndex:entities.json');
      return emptyEntityIndex();
    }
  }
  return emptyEntityIndex();
}

/**
 * Empty entity index structure
 */
export function emptyEntityIndex() {
  return {
    files: {},
    functions: {},
    errors: {},
    packages: {},
    lastUpdated: null
  };
}

/**
 * Update entity index with entities from an entry
 * @param {object} entry - Log entry
 * @param {string} cwd - Working directory
 * @param {object} config - Full config
 */
export function updateEntityIndex(entry, cwd = process.cwd(), config = {}) {
  const eeConfig = config.entityExtraction || {};
  if (eeConfig.enabled === false) return;

  const entities = extractEntitiesFromEntry(entry, eeConfig);
  if (Object.keys(entities).length === 0) return;

  const paths = ensureMemoryDirs(cwd);
  const lockPath = paths.entities + '.lock';

  // Lock the entire read-modify-write cycle to prevent concurrent updates
  // from overwriting each other. If lock is contended, skip — entity data
  // is reconstructable and losing one update is acceptable.
  withFileLock(lockPath, () => {
    const index = loadEntityIndex(cwd);
    const maxContexts = eeConfig.maxContextsPerEntity || 5;

    // Create context summary for this entry
    const contextSummary = {
      ts: entry.ts,
      type: entry.type,
      summary: truncateContext(entry.content || entry.subject || '', 80)
    };

    // Update each category
    for (const [category, names] of Object.entries(entities)) {
      if (!index[category]) index[category] = {};

      for (const name of names) {
        if (!index[category][name]) {
          index[category][name] = {
            mentions: 0,
            lastSeen: null,
            contexts: []
          };
        }

        const entityData = index[category][name];
        entityData.mentions++;
        entityData.lastSeen = entry.ts;

        // Add context, keeping only the most recent N
        entityData.contexts.push(contextSummary);
        if (entityData.contexts.length > maxContexts) {
          entityData.contexts = entityData.contexts.slice(-maxContexts);
        }
      }
    }

    index.lastUpdated = new Date().toISOString();

    // Prune stale entities (at most once per day)
    pruneEntityIndex(index, eeConfig);

    // Write updated index
    try {
      writeFileSync(paths.entities, JSON.stringify(index, null, 2));
    } catch (e) {
      logError(e, 'updateEntityIndex:write');
    }
  });
}

/**
 * Prune stale entities from the index.
 * Removes entities whose lastSeen is older than maxAgeDays.
 * Runs at most once per day (checks index.lastPruned).
 * Mutates the index object in place.
 */
function pruneEntityIndex(index, eeConfig = {}) {
  const maxAgeDays = eeConfig.maxAgeDays ?? 30;
  if (maxAgeDays <= 0) return; // Pruning disabled

  // Only prune once per day
  if (index.lastPruned) {
    const sincePrune = Date.now() - new Date(index.lastPruned).getTime();
    if (sincePrune < 24 * 60 * 60 * 1000) return;
  }

  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

  for (const category of ['files', 'functions', 'errors', 'packages']) {
    if (!index[category]) continue;
    for (const [name, data] of Object.entries(index[category])) {
      if (!data.lastSeen || new Date(data.lastSeen).getTime() < cutoff) {
        delete index[category][name];
      }
    }
  }

  index.lastPruned = new Date().toISOString();
}

/**
 * Truncate text for context summaries
 */
function truncateContext(text, maxLen) {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 3) + '...';
}

/**
 * Get entity mentions relevant to current context
 * @param {string} cwd - Working directory
 * @param {Array} recentFiles - Recently accessed files (optional)
 * @returns {object} Relevant entity data
 */
export function getRelevantEntities(cwd = process.cwd(), recentFiles = []) {
  const index = loadEntityIndex(cwd);
  const result = { files: [], functions: [], errors: [], packages: [] };

  // Score entities by recency and mention count
  const entityCategories = ['files', 'functions', 'errors', 'packages'];
  for (const category of entityCategories) {
    const entities = index[category];
    if (!entities || typeof entities !== 'object') continue;

    const scored = [];
    for (const [name, data] of Object.entries(entities)) {
      const recency = data.lastSeen ? calculateRecencyScore(data.lastSeen, 24) : 0;
      const frequency = Math.min(data.mentions / 10, 1); // Cap at 10 mentions
      const score = 0.6 * recency + 0.4 * frequency;

      // Boost if name matches recent files
      const nameBoost = recentFiles.some(f => f.includes(name)) ? 0.3 : 0;

      scored.push({ name, data, score: score + nameBoost });
    }

    scored.sort((a, b) => b.score - a.score);
    result[category] = scored.slice(0, 10).map(s => ({
      name: s.name,
      mentions: s.data.mentions,
      lastSeen: s.data.lastSeen,
      recentContext: s.data.contexts[s.data.contexts.length - 1]?.summary
    }));
  }

  return result;
}

/**
 * Calculate recency score with exponential decay
 * @param {string} timestamp - ISO timestamp of entry
 * @param {number} halfLifeHours - Hours until score drops to 50%
 * @returns {number} Score between 0 and 1
 */
function calculateRecencyScore(timestamp, halfLifeHours = 24) {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  // Exponential decay: score = 0.5^(age/halfLife)
  return Math.pow(0.5, ageHours / halfLifeHours);
}

/**
 * Calculate file relevance score based on path matching
 * @param {object} entry - Log entry
 * @param {string} cwd - Current working directory
 * @returns {number} Score between 0 and 1
 */
function calculateFileRelevanceScore(entry, cwd) {
  const filePaths = extractFilePaths(entry);
  if (filePaths.length === 0) return 0.5; // Neutral score for entries without file paths

  let relevantCount = 0;
  const cwdParts = cwd.split('/').filter(Boolean);
  const projectName = cwdParts[cwdParts.length - 1] || '';

  for (const filePath of filePaths) {
    // Check if file path is relative (likely in current project)
    if (!filePath.startsWith('/') && !filePath.startsWith('~')) {
      relevantCount++;
      continue;
    }

    // Check if absolute path contains project name or cwd
    if (filePath.includes(projectName) || filePath.includes(cwd)) {
      relevantCount++;
      continue;
    }

    // Check for common project directories
    if (filePath.match(/^(src|lib|test|scripts|plugin|components|pages)\//)) {
      relevantCount++;
    }
  }

  return filePaths.length > 0 ? relevantCount / filePaths.length : 0.5;
}

/**
 * Calculate entry type priority score
 * Considers both entry type and task outcome if applicable
 * @param {object} entry - Log entry
 * @param {object} typePriorities - Priority map by entry type
 * @param {object} outcomePriority - Priority map for task outcomes
 * @returns {number} Score between 0 and 1
 */
function calculateTypePriorityScore(entry, typePriorities, outcomePriority = null) {
  const type = entry.type || 'unknown';
  let baseScore = typePriorities[type] ?? 0.5;

  // Apply outcome modifier for task entries
  if (type === 'task' && entry.outcome && outcomePriority) {
    const outcomeMultiplier = outcomePriority[entry.outcome] ?? 1.0;
    baseScore *= outcomeMultiplier;
  }

  return baseScore;
}

/**
 * Deduplicate log entries by grouping temporally close entries and keeping highest-signal
 *
 * When you ask Claude to do something, multiple entries are created:
 * - prompt: Your request
 * - task: The work item created
 * - response: What Claude did
 * - commit: The final commit (if any)
 *
 * These are all about the same work. This function groups them and keeps the highest-signal entry.
 *
 * @param {Array} entries - Parsed log entries (should be sorted by timestamp)
 * @param {object} config - Full config object
 * @returns {Array} Deduplicated entries
 */
export function deduplicateEntries(entries, config = {}) {
  const dedupConfig = config.deduplication || {};

  if (dedupConfig.enabled === false || entries.length <= 1) {
    return entries;
  }

  const timeWindowMs = (dedupConfig.timeWindowMinutes || 5) * 60 * 1000;
  const typePriority = dedupConfig.typePriority || {
    commit: 100,
    task: 80,
    agent: 70,
    prompt: 40,
    response: 30,
    compact: 20
  };
  const mergeContext = dedupConfig.mergeContext !== false;

  // Sort by timestamp (oldest first)
  const sorted = [...entries].sort((a, b) =>
    new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );

  // Group entries by time proximity
  const groups = [];
  let currentGroup = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const timeDiff = new Date(curr.ts).getTime() - new Date(prev.ts).getTime();

    if (timeDiff <= timeWindowMs) {
      // Within time window - add to current group
      currentGroup.push(curr);
    } else {
      // New group
      groups.push(currentGroup);
      currentGroup = [curr];
    }
  }
  groups.push(currentGroup); // Don't forget the last group

  // Outcome priority for tasks (completed > in_progress > abandoned)
  const outcomePriority = { completed: 1.0, in_progress: 0.7, abandoned: 0.3 };

  // For each group, keep the highest-signal entry
  const deduplicated = groups.map(group => {
    if (group.length === 1) {
      return group[0];
    }

    // Sort by priority (highest first), considering outcome for tasks
    group.sort((a, b) => {
      let aPriority = typePriority[a.type] || 0;
      let bPriority = typePriority[b.type] || 0;

      // Apply outcome modifier for tasks
      if (a.type === 'task' && a.outcome) {
        aPriority *= (outcomePriority[a.outcome] || 1.0);
      }
      if (b.type === 'task' && b.outcome) {
        bPriority *= (outcomePriority[b.outcome] || 1.0);
      }

      return bPriority - aPriority;
    });

    const winner = group[0];

    // Optionally merge context from other entries
    if (mergeContext && group.length > 1) {
      const otherTypes = group.slice(1).map(e => e.type).filter((v, i, a) => a.indexOf(v) === i);
      if (otherTypes.length > 0) {
        // Add a note about what else was in this group
        winner._mergedFrom = otherTypes;
      }
    }

    return winner;
  });

  return deduplicated;
}

/**
 * Calculate entity relevance score based on indexed entities
 * @param {object} entry - Log entry
 * @param {object} entityIndex - Entity index
 * @param {object} config - Entity extraction config
 * @returns {number} Score between 0 and 1
 */
function calculateEntityRelevanceScore(entry, entityIndex, config = {}) {
  if (!entityIndex || Object.keys(entityIndex).length === 0) return 0.5;

  const entities = extractEntitiesFromEntry(entry, config);
  if (Object.keys(entities).length === 0) return 0.5;

  let totalScore = 0;
  let entityCount = 0;

  // Score based on how "hot" the entities mentioned are (recent + frequent = hot)
  for (const [category, names] of Object.entries(entities)) {
    if (!entityIndex[category]) continue;

    for (const name of names) {
      const entityData = entityIndex[category][name];
      if (!entityData) continue;

      entityCount++;
      const recency = entityData.lastSeen ? calculateRecencyScore(entityData.lastSeen, 24) : 0;
      const frequency = Math.min(entityData.mentions / 10, 1);
      totalScore += 0.6 * recency + 0.4 * frequency;
    }
  }

  return entityCount > 0 ? totalScore / entityCount : 0.5;
}

/**
 * Score and rank log entries by relevance
 * @param {Array} entries - Parsed log entries
 * @param {string} cwd - Current working directory
 * @param {object} config - Full config object
 * @returns {Array} Entries sorted by relevance score (highest first)
 */
export function scoreEntriesByRelevance(entries, cwd, config) {
  const rsConfig = config.relevanceScoring || {};

  if (rsConfig.enabled === false) {
    // If disabled, return entries in reverse chronological order
    return [...entries].reverse();
  }

  const weights = rsConfig.weights || { recency: 0.4, fileRelevance: 0.35, typePriority: 0.25 };
  const typePriorities = rsConfig.typePriorities || {
    commit: 1.0,
    task: 0.9,
    agent: 0.8,
    prompt: 0.5,
    response: 0.3,
    compact: 0.4
  };
  const halfLifeHours = rsConfig.recencyHalfLifeHours || 24;

  // Get outcome priority config for task scoring
  const otConfig = config.outcomeTracking || {};
  const outcomePriority = otConfig.enabled !== false ? (otConfig.outcomePriority || {
    completed: 1.0,
    in_progress: 0.7,
    abandoned: 0.3
  }) : null;

  // Load entity index for entity-based scoring
  const eeConfig = config.entityExtraction || {};
  let entityIndex = null;
  if (eeConfig.enabled !== false && eeConfig.useInRelevanceScoring !== false) {
    entityIndex = loadEntityIndex(cwd);
  }

  // Score each entry
  const scored = entries.map(entry => {
    const recencyScore = calculateRecencyScore(entry.ts, halfLifeHours);
    const fileScore = calculateFileRelevanceScore(entry, cwd);
    const typeScore = calculateTypePriorityScore(entry, typePriorities, outcomePriority);

    // Calculate entity relevance if enabled
    let entityScore = 0;
    if (entityIndex) {
      entityScore = calculateEntityRelevanceScore(entry, entityIndex, eeConfig);
    }

    // Weighted combination - adjust weights if entity scoring is active
    let totalScore;
    if (entityIndex && entityScore > 0.5) {
      // Blend in entity score, reducing other weights proportionally
      const entityWeight = 0.15;
      const scale = 1 - entityWeight;
      totalScore =
        scale * (weights.recency || 0) * recencyScore +
        scale * (weights.fileRelevance || 0) * fileScore +
        scale * (weights.typePriority || 0) * typeScore +
        entityWeight * entityScore;
    } else {
      totalScore =
        (weights.recency || 0) * recencyScore +
        (weights.fileRelevance || 0) * fileScore +
        (weights.typePriority || 0) * typeScore;
    }

    return {
      entry,
      score: totalScore,
      breakdown: { recency: recencyScore, file: fileScore, type: typeScore, entity: entityScore }
    };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.map(s => s.entry);
}

/**
 * Append a log entry using the buffered write system.
 * Writes to .pending.jsonl for batching, then flushes if throttle allows.
 * Also extracts and indexes entities from the entry.
 */
export function appendLogEntry(entry, cwd = process.cwd()) {
  const paths = ensureMemoryDirs(cwd);
  const pendingPath = paths.log.replace('.jsonl', '.pending.jsonl');
  const config = loadConfig();

  // Always write to pending file (fast, append-only)
  appendFileSync(pendingPath, JSON.stringify(entry) + '\n');

  // Extract and index entities from the entry
  updateEntityIndex(entry, cwd, config);

  // Invalidate cache since data has changed
  invalidateCache(cwd);

  // Throttled flush - only flush every 5 seconds
  flushPendingLog(cwd, 5000);
}

/**
 * Flush pending log entries to main log file.
 * Uses throttling to avoid excessive I/O.
 * @param {string} cwd - Working directory
 * @param {number} throttleMs - Minimum ms between flushes (0 = always flush)
 */
export function flushPendingLog(cwd = process.cwd(), throttleMs = 0) {
  const paths = ensureMemoryDirs(cwd);
  const pendingPath = paths.log.replace('.jsonl', '.pending.jsonl');
  const flushingPath = pendingPath + '.flushing';
  const lastFlushPath = paths.log + '.lastflush';

  // Check throttle
  if (throttleMs > 0 && existsSync(lastFlushPath)) {
    try {
      const lastFlush = parseInt(readFileSync(lastFlushPath, 'utf-8'), 10);
      if (Date.now() - lastFlush < throttleMs) {
        return; // Too soon, skip flush
      }
    } catch {
      // Ignore read errors
    }
  }

  if (!existsSync(pendingPath)) {
    return;
  }

  // Atomic rename: only one process wins; losers get ENOENT.
  // New entries written after this go to a fresh pending file.
  try {
    renameSync(pendingPath, flushingPath);
  } catch (e) {
    if (e.code === 'ENOENT') return; // Another process already claimed it
    logError(e, 'flushPendingLog:rename');
    return;
  }

  try {
    const pending = readFileSync(flushingPath, 'utf-8').trim();
    if (pending) {
      appendFileSync(paths.log, pending + '\n');
    }

    // Remove the flushing file now that entries are safely in the main log
    unlinkSync(flushingPath);

    // Update last flush timestamp
    writeFileSync(lastFlushPath, Date.now().toString());

    // Now check if summarization is needed (once, after batch)
    maybeSummarize(cwd);
  } catch (e) {
    // If append failed, restore pending file so entries aren't lost
    try {
      if (existsSync(flushingPath)) {
        renameSync(flushingPath, pendingPath);
      }
    } catch {}
    logError(e, 'flushPendingLog');
  }
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

    // Acquire lock atomically using O_EXCL (fails if file already exists)
    const lockFile = paths.log + '.lock';
    try {
      // If lock exists, check if it's stale
      if (existsSync(lockFile)) {
        const lockContent = readFileSync(lockFile, 'utf-8').trim();
        const lockTime = parseInt(lockContent, 10);
        if (lockTime && Date.now() - lockTime < 5 * 60 * 1000) {
          return; // Lock is fresh, summarization already running
        }
        // Stale lock — remove it so we can try to acquire
        try { unlinkSync(lockFile); } catch {}
      }

      // Atomic create: O_CREAT | O_EXCL | O_WRONLY fails if another process created it first
      const fd = openSync(lockFile, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
      const timestamp = Buffer.from(Date.now().toString());
      writeSync(fd, timestamp);
      closeSync(fd);
    } catch {
      // Another process won the race — let it handle summarization
      return;
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
  } catch (e) {
    logError(e, 'maybeSummarize');
  }
}

// ============================================================================
// Dependency Management
// ============================================================================

/**
 * Ensure npm dependencies are installed in the plugin directory.
 * Checks for the SDK package and runs `npm install` if missing.
 * @returns {boolean} true if deps are available, false if install failed
 */
export function ensureDeps() {
  const __filename = fileURLToPath(import.meta.url);
  const pluginRoot = join(dirname(__filename), '..');
  const sdkPath = join(pluginRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');

  if (existsSync(sdkPath)) {
    return true;
  }

  try {
    execFileSync('npm', ['install', '--omit=dev'], {
      cwd: pluginRoot,
      stdio: 'ignore',
      timeout: 60000
    });
    return existsSync(sdkPath);
  } catch (error) {
    logError(error, 'ensureDeps');
    return false;
  }
}

// ============================================================================
// Error Logging
// ============================================================================

/**
 * Get the path to the error log file
 */
export function getErrorLogPath() {
  return join(MEMORY_BASE, 'errors.log');
}

/**
 * Log an error to the error log file
 * @param {Error|string} error - The error to log
 * @param {string} context - Context about where the error occurred (e.g., 'session-start', 'sync')
 */
export function logError(error, context = 'unknown') {
  try {
    const errorLogPath = getErrorLogPath();
    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : null;

    const entry = {
      ts: timestamp,
      context,
      message,
      stack: stack ? stack.split('\n').slice(1, 4).map(l => l.trim()).join(' | ') : null
    };

    // Ensure base directory exists
    if (!existsSync(MEMORY_BASE)) {
      mkdirSync(MEMORY_BASE, { recursive: true });
    }

    // Append to error log
    appendFileSync(errorLogPath, JSON.stringify(entry) + '\n');

    // Rotate log if it gets too large (keep last 100 errors)
    rotateErrorLog(errorLogPath, 100);
  } catch {
    // Can't log the error - fail silently
  }
}

/**
 * Rotate error log to keep only the last N entries
 */
function rotateErrorLog(logPath, maxEntries) {
  try {
    if (!existsSync(logPath)) return;

    const content = readFileSync(logPath, 'utf-8').trim();
    if (!content) return;

    const lines = content.split('\n').filter(l => l);
    if (lines.length > maxEntries) {
      const trimmed = lines.slice(-maxEntries).join('\n') + '\n';
      writeFileSync(logPath, trimmed);
    }
  } catch {
    // Ignore rotation errors
  }
}

/**
 * Get recent errors from the error log
 * @param {number} maxCount - Maximum number of errors to return
 * @returns {Array} Recent error entries
 */
export function getRecentErrors(maxCount = 10) {
  try {
    const errorLogPath = getErrorLogPath();
    if (!existsSync(errorLogPath)) {
      return [];
    }

    const content = readFileSync(errorLogPath, 'utf-8').trim();
    if (!content) return [];

    const lines = content.split('\n').filter(l => l);
    const errors = lines
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean);

    return errors.slice(-maxCount).reverse(); // Most recent first
  } catch {
    return [];
  }
}

/**
 * Clear the error log
 */
export function clearErrorLog() {
  try {
    const errorLogPath = getErrorLogPath();
    if (existsSync(errorLogPath)) {
      writeFileSync(errorLogPath, '');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get errors from the last N hours
 * @param {number} hours - Number of hours to look back
 * @returns {Array} Errors within the time window
 */
export function getErrorsSince(hours = 24) {
  const errors = getRecentErrors(100);
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);

  return errors.filter(e => {
    const errorTime = new Date(e.ts).getTime();
    return errorTime >= cutoff;
  });
}
