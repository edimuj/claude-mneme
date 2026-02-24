/**
 * Memory Retriever — context-aware memory retrieval for session-start.
 *
 * Gathers context signals (git status, branch, handoff, entities),
 * tokenizes into weighted search terms, scores all memory sources,
 * returns ranked results. Falls back to null when signals are weak.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

// ============================================================================
// Tokenizer
// ============================================================================

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'are',
  'this', 'that', 'not', 'has', 'had', 'have', 'will', 'can', 'do',
  'did', 'been', 'its', 'than', 'then', 'them', 'their', 'some',
  'into', 'out', 'also', 'just', 'more', 'only', 'very', 'all',
  'new', 'use', 'used', 'using', 'get', 'set',
  // File/code noise
  'mjs', 'cjs', 'json', 'const', 'let', 'var', 'function', 'async',
  'await', 'return', 'export', 'import', 'default', 'true', 'false',
  'null', 'undefined', 'src', 'lib', 'test', 'tests', 'index',
]);

/**
 * Tokenize text into searchable terms.
 * Handles camelCase, snake_case, kebab-case, file paths.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text) return [];
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')       // camelCase split
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // XMLParser → XML Parser
    .replace(/[_\-]/g, ' ')                      // snake/kebab split
    .replace(/[/\\]/g, ' ')                      // path separator split
    .replace(/\.\w{1,5}(?=\s|$)/g, '')           // strip file extensions
    .replace(/[^a-zA-Z0-9\s]/g, ' ')             // non-alphanum → space
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

// ============================================================================
// Text Relevance Scorer
// ============================================================================

/**
 * Score how well text matches search terms. Returns 0-1.
 * @param {string} text
 * @param {{ tokenWeights: Map<string,number>, rawFilePaths: string[] }} searchTerms
 * @returns {number}
 */
export function scoreTextRelevance(text, searchTerms) {
  if (!text || searchTerms.tokenWeights.size === 0) return 0;

  const textTokens = new Set(tokenize(text));
  let weightedHits = 0;
  let maxPossibleWeight = 0;

  for (const [token, weight] of searchTerms.tokenWeights) {
    maxPossibleWeight += weight;
    if (textTokens.has(token)) {
      weightedHits += weight;
    }
  }

  if (maxPossibleWeight === 0) return 0;
  let score = weightedHits / maxPossibleWeight;

  // Boost for exact file path match
  for (const filePath of searchTerms.rawFilePaths) {
    const basename = filePath.split('/').pop();
    if (text.includes(basename) || text.includes(filePath)) {
      score = Math.min(1, score + 0.3);
      break;
    }
  }

  return score;
}

// ============================================================================
// Context Signal Gathering
// ============================================================================

const UNINFORMATIVE_BRANCHES = new Set([
  'main', 'master', 'develop', 'dev', 'staging', 'production', 'release', 'HEAD',
]);
const BRANCH_PREFIXES = /^(feature|fix|bugfix|hotfix|release|chore|docs|refactor|test|ci)\//i;
const MAX_MODIFIED_FILES = 20;

/**
 * Gather context signals from the environment.
 * @param {string} cwd - Project working directory
 * @param {object} cachedData - { entities } from readCachedData()
 * @param {object} paths - { handoff } from ensureMemoryDirs()
 * @returns {ContextSignals}
 */
export function gatherContextSignals(cwd, cachedData, paths) {
  let modifiedFiles = [];
  let stagedFiles = [];
  let branchName = '';

  // Git status
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const statusLines = status.split('\n').filter(l => l.length >= 4);
    if (statusLines.length > 0) {
      for (const line of statusLines) {
        const indexStatus = line[0];
        const workStatus = line[1];
        const filePath = line.slice(3);
        if (!filePath) continue;
        if (workStatus === 'M' || workStatus === 'D' || workStatus === '?') {
          modifiedFiles.push(filePath);
        }
        if (indexStatus === 'M' || indexStatus === 'A' || indexStatus === 'D' || indexStatus === 'R') {
          stagedFiles.push(filePath);
        }
      }
    }
  } catch { /* not a git repo or git error */ }

  // Branch name
  try {
    branchName = execFileSync('git', ['branch', '--show-current'], {
      encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { /* not a git repo */ }

  // Handoff
  let handoff = null;
  const handoffPath = paths?.handoff;
  if (handoffPath && existsSync(handoffPath)) {
    try {
      const data = JSON.parse(readFileSync(handoffPath, 'utf-8'));
      const maxAgeMs = 48 * 60 * 60 * 1000;
      if (data.ts && (Date.now() - new Date(data.ts).getTime()) < maxAgeMs) {
        handoff = data;
      }
    } catch { /* corrupt handoff — skip */ }
  }

  // Hot entity names (top 5 by recency * frequency from entity index)
  let hotEntityNames = [];
  const entityIndex = cachedData?.entities;
  if (entityIndex) {
    const scored = [];
    for (const category of ['files', 'functions']) {
      for (const [name, data] of Object.entries(entityIndex[category] || {})) {
        const recency = data.lastSeen
          ? Math.pow(0.5, (Date.now() - new Date(data.lastSeen).getTime()) / (24 * 3600000))
          : 0;
        const frequency = Math.min((data.mentions || 0) / 10, 1);
        scored.push({ name, score: 0.6 * recency + 0.4 * frequency });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    hotEntityNames = scored.slice(0, 5).map(e => e.name);
  }

  return { modifiedFiles, stagedFiles, branchName, handoff, hotEntityNames };
}

// ============================================================================
// Search Term Extraction
// ============================================================================

/**
 * Extract weighted search terms from context signals.
 * @param {ContextSignals} signals
 * @returns {SearchTerms}
 */
export function extractSearchTerms(signals) {
  const tokenWeights = new Map();
  const rawFilePaths = (signals.modifiedFiles || []).slice(0, MAX_MODIFIED_FILES);
  let signalCount = 0;

  const addTokens = (tokens, weight) => {
    for (const t of tokens) {
      const existing = tokenWeights.get(t) || 0;
      tokenWeights.set(t, Math.max(existing, weight)); // keep highest weight
    }
  };

  // 1. File tokens (weight 0.8)
  const allFiles = [...rawFilePaths, ...(signals.stagedFiles || []).slice(0, MAX_MODIFIED_FILES)];
  if (allFiles.length > 0) {
    signalCount++;
    for (const fp of allFiles) {
      const basename = fp.split('/').pop()?.replace(/\.\w{1,5}$/, '') || '';
      addTokens(tokenize(basename), 0.8);
    }
    // Directory components at lower weight
    for (const fp of allFiles) {
      const parts = fp.split('/').slice(0, -1);
      for (const part of parts) {
        addTokens(tokenize(part), 0.4);
      }
    }
  }

  // 2. Intent tokens from branch name (weight 1.0)
  const branch = signals.branchName || '';
  if (branch && !UNINFORMATIVE_BRANCHES.has(branch)) {
    signalCount++;
    const cleaned = branch.replace(BRANCH_PREFIXES, '');
    addTokens(tokenize(cleaned), 1.0);
  }

  // 3. Concept tokens from handoff (weight 0.6)
  if (signals.handoff) {
    signalCount++;
    const parts = [
      signals.handoff.workingOn,
      signals.handoff.keyInsight,
      signals.handoff.lastDone,
      ...(signals.handoff.openItems || []),
    ].filter(Boolean);
    for (const part of parts) {
      addTokens(tokenize(part), 0.6);
    }
  }

  // 4. Hot entity tokens (weight 0.4)
  if (signals.hotEntityNames?.length > 0) {
    signalCount++;
    for (const name of signals.hotEntityNames) {
      addTokens(tokenize(name), 0.4);
    }
  }

  // Signal strength: fraction of signal sources that contributed
  const maxSignals = 4; // files, branch, handoff, entities
  const signalStrength = signalCount / maxSignals;

  return { tokenWeights, rawFilePaths, signalStrength };
}

// ============================================================================
// Memory Retrieval
// ============================================================================

const DEFAULT_RETRIEVAL_CONFIG = {
  minSignalStrength: 0.2,
  relevanceThreshold: 0.15,
  alwaysIncludeFoundational: true,
  budgets: { decisions: 5, state: 5, work: 3, entries: 6 },
};

/**
 * Score and retrieve relevant memories across all data sources.
 * Returns null if signals are too weak (caller should fall back to existing behavior).
 *
 * @param {SearchTerms} searchTerms
 * @param {object} cachedData - { summary, logEntries, remembered, entities }
 * @param {object} config - User config (memoryRetrieval section merged with defaults)
 * @returns {object|null} Retrieved memory with _relevance scores, or null for fallback
 */
export function retrieveRelevantMemory(searchTerms, cachedData, config) {
  const rc = { ...DEFAULT_RETRIEVAL_CONFIG, ...config?.memoryRetrieval };

  if (searchTerms.signalStrength < rc.minSignalStrength) return null;

  const summary = cachedData.summary || {};
  const threshold = rc.relevanceThreshold;
  const budgets = rc.budgets;

  // Score each data source
  const scoredDecisions = (summary.keyDecisions || []).map(d => ({
    ...d,
    _relevance: scoreTextRelevance(`${d.decision} ${d.reason || ''}`, searchTerms),
  }));

  const scoredState = (summary.currentState || []).map(s => ({
    ...s,
    _relevance: scoreTextRelevance(`${s.topic} ${s.status}`, searchTerms),
  }));

  const scoredWork = (summary.recentWork || []).map(w => ({
    ...w,
    _relevance: scoreTextRelevance(w.summary || '', searchTerms) +
      (w.date ? recencyBonus(w.date + 'T12:00:00Z', 168) : 0),
  }));

  const typeBonuses = { commit: 0.15, task: 0.1, agent: 0.1, prompt: 0.05, response: 0.05 };
  const scoredEntries = (cachedData.logEntries || []).map(e => ({
    ...e,
    _relevance: scoreTextRelevance(e.content || '', searchTerms) +
      recencyBonus(e.ts, 24) +
      (typeBonuses[e.type] || 0),
  }));

  const scoredRemembered = (cachedData.remembered || []).map(r => ({
    ...r,
    _relevance: scoreTextRelevance(r.content || '', searchTerms) +
      (r.type === 'lesson' ? 0.1 : 0),
  }));

  return {
    projectContext: summary.projectContext || '',
    decisions: selectByRelevance(scoredDecisions, budgets.decisions, threshold, rc.alwaysIncludeFoundational),
    state: selectByRelevance(scoredState, budgets.state, threshold),
    work: selectByRelevance(scoredWork, budgets.work, threshold),
    entries: selectByRelevance(scoredEntries, budgets.entries, threshold),
    remembered: scoredRemembered, // always include all
    signalStrength: searchTerms.signalStrength,
  };
}

function recencyBonus(isoTs, halfLifeHours) {
  if (!isoTs) return 0;
  const ageMs = Date.now() - new Date(isoTs).getTime();
  const ageHours = ageMs / 3600000;
  return Math.pow(0.5, ageHours / halfLifeHours) * 0.2;
}

function selectByRelevance(items, maxCount, threshold, includeFoundational = false) {
  if (!items || items.length === 0) return [];

  const sorted = [...items].sort((a, b) => (b._relevance || 0) - (a._relevance || 0));
  const relevant = sorted.filter(i => (i._relevance || 0) >= threshold);
  const selected = relevant.slice(0, maxCount);

  // Guarantee: at least one item (most relevant, even if below threshold)
  if (selected.length === 0 && sorted.length > 0) {
    selected.push(sorted[0]);
  }

  // Always include foundational decisions
  if (includeFoundational) {
    for (const item of items) {
      if (item.foundational && !selected.includes(item)) {
        selected.push(item);
      }
    }
  }

  return selected;
}
