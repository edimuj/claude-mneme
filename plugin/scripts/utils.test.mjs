/**
 * Tests for claude-mneme utility functions
 *
 * Run: node --test plugin/scripts/utils.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import the functions under test — some are not exported, so we test
// the exported wrappers that exercise them.
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { before, after } from 'node:test';

import {
  escapeAttr,
  splitSentences,
  extractiveSummarize,
  deduplicateEntries,
  extractEntitiesFromEntry,
  emptyEntityIndex,
  emptyStructuredSummary,
  formatEntry,
  formatEntriesForSummary,
  renderSummaryToMarkdown,
  withFileLock,
  loadConfig,
  flushPendingLog,
  ensureMemoryDirs,
  getProjectRoot,
  getProjectName,
  MEMORY_BASE,
  calculateRecencyScore,
  calculateFileRelevanceScore,
  calculateTypePriorityScore,
  calculateEntityRelevanceScore,
  pruneEntityIndex,
  extractFilePaths,
  isFileFalsePositive,
  extractFunctionNames,
  extractErrorMessages,
  extractPackageNames,
  isValidPackageName,
  stripMarkdown,
} from './utils.mjs';

// ============================================================================
// escapeAttr
// ============================================================================

describe('escapeAttr', () => {
  it('passes through safe strings unchanged', () => {
    assert.equal(escapeAttr('hello world'), 'hello world');
  });

  it('escapes ampersands', () => {
    assert.equal(escapeAttr('a&b'), 'a&amp;b');
  });

  it('escapes double quotes', () => {
    assert.equal(escapeAttr('say "hi"'), 'say &quot;hi&quot;');
  });

  it('escapes angle brackets', () => {
    assert.equal(escapeAttr('<script>'), '&lt;script&gt;');
  });

  it('escapes all special chars together', () => {
    assert.equal(escapeAttr('a & "b" <c>'), 'a &amp; &quot;b&quot; &lt;c&gt;');
  });

  it('coerces non-strings', () => {
    assert.equal(escapeAttr(42), '42');
    assert.equal(escapeAttr(null), 'null');
  });
});

// ============================================================================
// splitSentences
// ============================================================================

describe('splitSentences', () => {
  it('splits simple sentences', () => {
    const result = splitSentences('First sentence. Second sentence.');
    assert.equal(result.length, 2);
  });

  it('handles bullet lists', () => {
    const result = splitSentences('- item one\n- item two\n- item three');
    assert.equal(result.length, 3);
    assert.equal(result[0], 'item one');
  });

  it('returns single unit for short text', () => {
    const result = splitSentences('just a phrase');
    assert.deepEqual(result, ['just a phrase']);
  });

  it('handles empty input', () => {
    const result = splitSentences('');
    assert.deepEqual(result, []);
  });

  it('splits paragraphs', () => {
    const result = splitSentences('Para one.\n\nPara two.');
    assert.equal(result.length, 2);
  });
});

// ============================================================================
// extractiveSummarize
// ============================================================================

describe('extractiveSummarize', () => {
  const defaultConfig = {
    maxSummarySentences: 4,
    actionWords: [
      'fixed', 'added', 'created', 'updated', 'removed', 'deleted',
      'implemented', 'refactored', 'resolved'
    ],
    reasoningWords: [
      'because', 'instead', 'decided', "can't", 'avoid', 'prefer', 'constraint'
    ]
  };

  it('returns empty for empty input', () => {
    assert.equal(extractiveSummarize('', defaultConfig), '');
  });

  it('keeps action sentences', () => {
    const text = 'Fixed the authentication bug in login flow. The weather is nice today.';
    const result = extractiveSummarize(text, { ...defaultConfig, maxSummarySentences: 1 });
    assert.ok(result.includes('Fixed'), `Expected "Fixed" in: ${result}`);
  });

  it('respects maxSummarySentences', () => {
    const text = 'Added auth. Fixed bug. Created test. Updated docs. Removed dead code.';
    const result = extractiveSummarize(text, { ...defaultConfig, maxSummarySentences: 2 });
    const sentences = result.split(/[.!?]\s+/).filter(s => s.trim());
    assert.ok(sentences.length <= 3, `Expected <=3 sentences, got ${sentences.length}`);
  });

  it('strips lead-in phrases', () => {
    const text = "Here's what I did. Fixed the authentication bug.";
    const result = extractiveSummarize(text, { ...defaultConfig, maxSummarySentences: 2 });
    assert.ok(!result.startsWith("Here's"), `Should strip lead-in: ${result}`);
  });

  it('always keeps the first sentence', () => {
    // First sentence has no action/reasoning words but should still be kept
    const text = 'The system has three components. Added auth. Fixed bug. Created test. Updated docs.';
    const result = extractiveSummarize(text, { ...defaultConfig, maxSummarySentences: 2 });
    assert.ok(result.includes('three components'), `First sentence should be kept: ${result}`);
  });

  it('scores reasoning words', () => {
    const text = "We can't use Redis because serialization overhead is too high. The sky is blue. Added a log line.";
    const result = extractiveSummarize(text, { ...defaultConfig, maxSummarySentences: 2 });
    assert.ok(result.includes("can't use Redis"), `Should keep reasoning sentence: ${result}`);
  });

  it('scores entity references (file paths)', () => {
    const text = 'Something happened. The change is in src/auth.ts for the login module. Nothing else matters.';
    const result = extractiveSummarize(text, { ...defaultConfig, maxSummarySentences: 2 });
    assert.ok(result.includes('src/auth.ts'), `Should keep entity sentence: ${result}`);
  });

  it('works with empty word lists', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const result = extractiveSummarize(text, { maxSummarySentences: 2, actionWords: [], reasoningWords: [] });
    // Should still return something (first sentence + one more)
    assert.ok(result.includes('First sentence'), `Should keep first sentence: ${result}`);
  });
});

// ============================================================================
// deduplicateEntries
// ============================================================================

describe('deduplicateEntries', () => {
  const baseTs = '2025-02-04T10:00:00Z';
  function ts(minutesOffset) {
    return new Date(new Date(baseTs).getTime() + minutesOffset * 60000).toISOString();
  }

  it('returns single entry unchanged', () => {
    const entries = [{ ts: baseTs, type: 'prompt', content: 'hello' }];
    const result = deduplicateEntries(entries);
    assert.equal(result.length, 1);
  });

  it('deduplicates entries within time window', () => {
    const entries = [
      { ts: ts(0), type: 'prompt', content: 'Fix the auth bug' },
      { ts: ts(1), type: 'task', content: 'Fix auth bug', action: 'created' },
      { ts: ts(2), type: 'commit', content: 'fix: auth bug in login flow' },
    ];
    const result = deduplicateEntries(entries);
    assert.equal(result.length, 1, 'Should deduplicate to 1 entry');
    assert.equal(result[0].type, 'commit', 'Commit should win (highest priority)');
  });

  it('preserves entries outside time window', () => {
    const entries = [
      { ts: ts(0), type: 'prompt', content: 'First task' },
      { ts: ts(10), type: 'prompt', content: 'Second task' }, // 10 min apart > 5 min window
    ];
    const result = deduplicateEntries(entries);
    assert.equal(result.length, 2);
  });

  it('respects enabled=false', () => {
    const entries = [
      { ts: ts(0), type: 'prompt', content: 'a' },
      { ts: ts(1), type: 'commit', content: 'b' },
    ];
    const result = deduplicateEntries(entries, { deduplication: { enabled: false } });
    assert.equal(result.length, 2);
  });

  it('adds merged context when mergeContext is true', () => {
    const entries = [
      { ts: ts(0), type: 'prompt', content: 'Fix auth' },
      { ts: ts(1), type: 'commit', content: 'fix: auth bug' },
    ];
    const result = deduplicateEntries(entries, { deduplication: { mergeContext: true } });
    assert.equal(result.length, 1);
    assert.ok(result[0]._mergedFrom, 'Should have _mergedFrom metadata');
    assert.ok(result[0]._mergedFrom.includes('prompt'), 'Should reference merged prompt type');
  });
});

// ============================================================================
// extractEntitiesFromEntry
// ============================================================================

describe('extractEntitiesFromEntry', () => {
  it('extracts file paths', () => {
    const entry = { content: 'Updated src/auth.ts and utils/helpers.mjs' };
    const result = extractEntitiesFromEntry(entry);
    assert.ok(result.files.includes('src/auth.ts'), `Expected src/auth.ts in ${result.files}`);
    assert.ok(result.files.includes('utils/helpers.mjs'), `Expected utils/helpers.mjs in ${result.files}`);
  });

  it('extracts error messages', () => {
    const entry = { content: 'Got TypeError: Cannot read property of undefined' };
    const result = extractEntitiesFromEntry(entry);
    assert.ok(result.errors.length > 0, 'Should extract at least one error');
    assert.ok(result.errors[0].includes('TypeError'), `Expected TypeError in ${result.errors}`);
  });

  it('extracts package names', () => {
    const entry = { content: 'npm install express @anthropic-ai/sdk lodash' };
    const result = extractEntitiesFromEntry(entry);
    assert.ok(result.packages, 'Should have packages key');
    assert.ok(result.packages.some(p => p === 'express' || p.includes('express')),
      `Expected express in ${JSON.stringify(result.packages)}`);
  });

  it('returns empty object for empty content', () => {
    // extractEntitiesFromEntry only includes keys when matches are found
    const result = extractEntitiesFromEntry({ content: '' });
    assert.equal(result.files, undefined);
    assert.equal(result.functions, undefined);
    assert.equal(result.errors, undefined);
    assert.equal(result.packages, undefined);
  });

  it('respects disabled categories', () => {
    const entry = { content: 'Updated src/auth.ts with handleLogin function' };
    const result = extractEntitiesFromEntry(entry, {
      categories: { files: false, functions: true, errors: true, packages: true }
    });
    assert.equal(result.files, undefined, 'files should not be extracted when disabled');
  });
});

// ============================================================================
// emptyStructuredSummary
// ============================================================================

describe('emptyStructuredSummary', () => {
  it('returns correct shape', () => {
    const summary = emptyStructuredSummary();
    assert.ok(Array.isArray(summary.keyDecisions));
    assert.ok(Array.isArray(summary.currentState));
    assert.ok(Array.isArray(summary.recentWork));
    assert.equal(summary.projectContext, '');
    assert.equal(summary.lastUpdated, null);
  });
});

// ============================================================================
// emptyEntityIndex
// ============================================================================

describe('emptyEntityIndex', () => {
  it('returns correct shape', () => {
    const index = emptyEntityIndex();
    assert.ok(typeof index.files === 'object');
    assert.ok(typeof index.functions === 'object');
    assert.ok(typeof index.errors === 'object');
    assert.ok(typeof index.packages === 'object');
  });
});

// ============================================================================
// formatEntry
// ============================================================================

describe('formatEntry', () => {
  it('formats a commit entry', () => {
    const result = formatEntry({
      ts: '2025-02-04T10:00:00Z',
      type: 'commit',
      content: 'fix: auth bug'
    });
    assert.ok(result.includes('Commit'), `Expected "Commit" in: ${result}`);
    assert.ok(result.includes('fix: auth bug'));
  });

  it('formats a task entry with action', () => {
    const result = formatEntry({
      ts: '2025-02-04T10:00:00Z',
      type: 'task',
      action: 'completed',
      subject: 'Fix auth bug'
    });
    assert.ok(result.includes('completed') || result.includes('Completed'));
  });

  it('formats a prompt entry', () => {
    const result = formatEntry({
      ts: '2025-02-04T10:00:00Z',
      type: 'prompt',
      content: 'Fix the login bug'
    });
    assert.ok(result.includes('Fix the login bug'));
  });
});

// ============================================================================
// formatEntriesForSummary
// ============================================================================

describe('formatEntriesForSummary', () => {
  it('formats JSON lines for summarization', () => {
    const lines = [
      JSON.stringify({ ts: '2025-02-04T10:00:00Z', type: 'commit', content: 'fix: auth' }),
      JSON.stringify({ ts: '2025-02-04T10:01:00Z', type: 'prompt', content: 'Fix bugs' }),
    ];
    const result = formatEntriesForSummary(lines);
    assert.ok(result.includes('fix: auth'));
    assert.ok(result.includes('Fix bugs'));
  });

  it('handles empty input', () => {
    const result = formatEntriesForSummary([]);
    assert.equal(result, '');
  });
});

// ============================================================================
// renderSummaryToMarkdown
// ============================================================================

describe('renderSummaryToMarkdown', () => {
  it('renders project context', () => {
    const summary = {
      ...emptyStructuredSummary(),
      projectContext: 'A test project',
      lastUpdated: '2025-02-04T10:00:00Z'
    };
    const result = renderSummaryToMarkdown(summary, 'test-project');
    assert.ok(result.high.includes('A test project'));
  });

  it('renders key decisions', () => {
    const summary = {
      ...emptyStructuredSummary(),
      keyDecisions: [{ date: '2025-02-04', decision: 'Use JWT', reason: 'Security' }],
      lastUpdated: '2025-02-04T10:00:00Z'
    };
    const result = renderSummaryToMarkdown(summary, 'test-project');
    assert.ok(result.high.includes('Use JWT'));
  });

  it('renders recent work in medium priority', () => {
    const summary = {
      ...emptyStructuredSummary(),
      recentWork: [{ date: new Date().toISOString().slice(0, 10), summary: 'Fixed auth' }],
      lastUpdated: new Date().toISOString()
    };
    const result = renderSummaryToMarkdown(summary, 'test-project');
    assert.ok(result.medium.includes('Fixed auth'));
  });

  it('returns only header for empty summary', () => {
    const summary = emptyStructuredSummary();
    const result = renderSummaryToMarkdown(summary, 'test-project');
    // Empty summary still gets the markdown header
    assert.ok(result.high.includes('Memory Summary'), 'Should have header');
    assert.ok(!result.high.includes('## Key Decisions'), 'Should not have decisions section');
  });
});

// ============================================================================
// withFileLock
// ============================================================================

describe('withFileLock', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mneme-test-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquires lock, runs fn, and returns result', () => {
    const lockPath = join(tmpDir, 'test1.lock');
    const result = withFileLock(lockPath, () => 42);
    assert.equal(result, 42);
    assert.ok(!existsSync(lockPath), 'Lock file should be cleaned up');
  });

  it('cleans up lock even if fn throws', () => {
    const lockPath = join(tmpDir, 'test2.lock');
    assert.throws(() => {
      withFileLock(lockPath, () => { throw new Error('boom'); });
    }, /boom/);
    assert.ok(!existsSync(lockPath), 'Lock file should be cleaned up after throw');
  });

  it('returns undefined when lock is held by another', () => {
    const lockPath = join(tmpDir, 'test3.lock');
    // Simulate a held lock
    writeFileSync(lockPath, 'other-pid');
    const result = withFileLock(lockPath, () => 42, 60); // 60s stale threshold
    assert.equal(result, undefined, 'Should return undefined when lock is held');
    // Clean up
    try { rmSync(lockPath); } catch {}
  });

  it('breaks stale locks', () => {
    const lockPath = join(tmpDir, 'test4.lock');
    // Create a lock file and set mtime to the past
    writeFileSync(lockPath, 'stale-pid');
    const result = withFileLock(lockPath, () => 'won', 0); // 0s = always stale
    assert.equal(result, 'won', 'Should break stale lock and run fn');
    assert.ok(!existsSync(lockPath), 'Lock should be cleaned up');
  });
});

// ============================================================================
// loadConfig caching
// ============================================================================

describe('loadConfig', () => {
  it('returns the same cached object on subsequent calls', () => {
    const config1 = loadConfig();
    const config2 = loadConfig();
    assert.equal(config1, config2, 'Should return same reference (cached)');
  });

  it('returns an object with expected default keys', () => {
    const config = loadConfig();
    assert.ok(config.maxLogEntriesBeforeSummarize > 0);
    assert.ok(config.keepRecentEntries > 0);
    assert.ok(typeof config.claudePath === 'string');
  });
});

// ============================================================================
// flushPendingLog
// ============================================================================

describe('flushPendingLog', () => {
  let tmpDir;
  let origCwd;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mneme-flush-'));
    origCwd = process.cwd();
    // Create the directory structure that ensureMemoryDirs expects
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('moves pending entries to main log', () => {
    const paths = ensureMemoryDirs(tmpDir);
    const pendingPath = paths.log.replace('.jsonl', '.pending.jsonl');

    const entry1 = JSON.stringify({ ts: new Date().toISOString(), type: 'test', content: 'entry1' });
    const entry2 = JSON.stringify({ ts: new Date().toISOString(), type: 'test', content: 'entry2' });
    appendFileSync(pendingPath, entry1 + '\n');
    appendFileSync(pendingPath, entry2 + '\n');

    flushPendingLog(tmpDir, 0);

    assert.ok(existsSync(paths.log), 'Main log should exist');
    const logContent = readFileSync(paths.log, 'utf-8');
    assert.ok(logContent.includes('entry1'), 'Main log should contain entry1');
    assert.ok(logContent.includes('entry2'), 'Main log should contain entry2');
    assert.ok(!existsSync(pendingPath), 'Pending file should be removed (renamed away)');
  });

  it('respects throttle', () => {
    const paths = ensureMemoryDirs(tmpDir);
    const pendingPath = paths.log.replace('.jsonl', '.pending.jsonl');
    const lastFlushPath = paths.log + '.lastflush';

    // Write a recent flush timestamp
    writeFileSync(lastFlushPath, Date.now().toString());
    appendFileSync(pendingPath, JSON.stringify({ ts: new Date().toISOString(), type: 'test', content: 'throttled' }) + '\n');

    const logBefore = existsSync(paths.log) ? readFileSync(paths.log, 'utf-8') : '';
    flushPendingLog(tmpDir, 60000); // 60s throttle
    const logAfter = existsSync(paths.log) ? readFileSync(paths.log, 'utf-8') : '';

    assert.equal(logBefore, logAfter, 'Log should not change when throttled');
    assert.ok(existsSync(pendingPath), 'Pending file should still exist');

    // Clean up for other tests
    rmSync(pendingPath, { force: true });
  });

  it('handles missing pending file gracefully', () => {
    // Should not throw
    flushPendingLog(tmpDir, 0);
  });
});

// ============================================================================
// calculateRecencyScore
// ============================================================================

describe('calculateRecencyScore', () => {
  it('returns ~1.0 for timestamps just now', () => {
    const score = calculateRecencyScore(new Date().toISOString());
    assert.ok(score > 0.99, `Expected >0.99, got ${score}`);
  });

  it('returns 0.5 at exactly one half-life', () => {
    const oneHalfLifeAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const score = calculateRecencyScore(oneHalfLifeAgo, 24);
    assert.ok(Math.abs(score - 0.5) < 0.01, `Expected ~0.5, got ${score}`);
  });

  it('returns 0.25 at two half-lives', () => {
    const twoHalfLivesAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const score = calculateRecencyScore(twoHalfLivesAgo, 24);
    assert.ok(Math.abs(score - 0.25) < 0.01, `Expected ~0.25, got ${score}`);
  });

  it('respects custom halfLifeHours', () => {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const score = calculateRecencyScore(sixHoursAgo, 6);
    assert.ok(Math.abs(score - 0.5) < 0.01, `Expected ~0.5 with 6h half-life, got ${score}`);
  });

  it('approaches zero for very old timestamps', () => {
    const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const score = calculateRecencyScore(yearAgo, 24);
    assert.ok(score < 0.001, `Expected near-zero for year-old entry, got ${score}`);
  });

  it('returns >1 for future timestamps', () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const score = calculateRecencyScore(future, 24);
    assert.ok(score > 1.0, `Future timestamps should score >1, got ${score}`);
  });
});

// ============================================================================
// calculateFileRelevanceScore
// ============================================================================

describe('calculateFileRelevanceScore', () => {
  it('returns 0.5 for entries without file paths', () => {
    const score = calculateFileRelevanceScore({ content: 'no files here' }, '/home/user/project');
    assert.equal(score, 0.5);
  });

  it('scores 1.0 for relative paths (assumed in-project)', () => {
    const score = calculateFileRelevanceScore(
      { content: 'Updated src/auth.ts and lib/utils.mjs' },
      '/home/user/project'
    );
    assert.equal(score, 1.0);
  });

  it('treats absolute paths as no-file (extractFilePaths ignores leading /)', () => {
    // extractFilePaths regex only matches relative-style paths
    const score = calculateFileRelevanceScore(
      { content: 'Changed /home/user/project/src/main.ts' },
      '/home/user/project'
    );
    assert.equal(score, 0.5, 'Absolute paths not extracted → neutral score');
  });

  it('only sees the relative path in a mix with absolute', () => {
    // /etc/hosts is ignored by extractFilePaths, only src/auth.ts is matched
    const score = calculateFileRelevanceScore(
      { content: 'Compared src/auth.ts with /etc/hosts' },
      '/home/user/project'
    );
    assert.equal(score, 1.0, 'Only relative src/auth.ts is extracted');
  });

  it('recognizes common project directory prefixes', () => {
    const score = calculateFileRelevanceScore(
      { content: 'Modified components/Header.tsx' },
      '/home/user/project'
    );
    assert.equal(score, 1.0);
  });
});

// ============================================================================
// calculateTypePriorityScore
// ============================================================================

describe('calculateTypePriorityScore', () => {
  const typePriorities = {
    commit: 1.0,
    task: 0.9,
    agent: 0.8,
    prompt: 0.5,
    response: 0.3,
  };

  it('returns the mapped priority for known types', () => {
    assert.equal(calculateTypePriorityScore({ type: 'commit' }, typePriorities), 1.0);
    assert.equal(calculateTypePriorityScore({ type: 'prompt' }, typePriorities), 0.5);
    assert.equal(calculateTypePriorityScore({ type: 'response' }, typePriorities), 0.3);
  });

  it('returns 0.5 for unknown types', () => {
    assert.equal(calculateTypePriorityScore({ type: 'custom' }, typePriorities), 0.5);
  });

  it('returns 0.5 for missing type field', () => {
    assert.equal(calculateTypePriorityScore({}, typePriorities), 0.5);
  });

  it('applies outcome multiplier for task entries', () => {
    const outcomePriority = { completed: 1.0, abandoned: 0.3 };
    const entry = { type: 'task', outcome: 'abandoned' };
    const score = calculateTypePriorityScore(entry, typePriorities, outcomePriority);
    assert.ok(Math.abs(score - 0.9 * 0.3) < 0.001, `Expected ${0.9 * 0.3}, got ${score}`);
  });

  it('ignores outcome for non-task entries', () => {
    const outcomePriority = { completed: 1.0, abandoned: 0.3 };
    const entry = { type: 'commit', outcome: 'abandoned' };
    const score = calculateTypePriorityScore(entry, typePriorities, outcomePriority);
    assert.equal(score, 1.0);
  });

  it('uses multiplier 1.0 for unknown outcomes', () => {
    const outcomePriority = { completed: 1.0 };
    const entry = { type: 'task', outcome: 'unknown_outcome' };
    const score = calculateTypePriorityScore(entry, typePriorities, outcomePriority);
    assert.equal(score, 0.9);
  });

  it('skips outcome when outcomePriority is null', () => {
    const entry = { type: 'task', outcome: 'abandoned' };
    const score = calculateTypePriorityScore(entry, typePriorities, null);
    assert.equal(score, 0.9);
  });
});

// ============================================================================
// calculateEntityRelevanceScore
// ============================================================================

describe('calculateEntityRelevanceScore', () => {
  it('returns 0.5 for empty entity index', () => {
    assert.equal(calculateEntityRelevanceScore({ content: 'anything' }, {}), 0.5);
    assert.equal(calculateEntityRelevanceScore({ content: 'anything' }, null), 0.5);
  });

  it('returns 0.5 for entry with no extractable entities', () => {
    const index = { files: { 'src/auth.ts': { mentions: 5, lastSeen: new Date().toISOString() } } };
    const score = calculateEntityRelevanceScore({ content: 'nothing relevant' }, index);
    assert.equal(score, 0.5);
  });

  it('scores high for recently-seen, frequently-mentioned entities', () => {
    const now = new Date().toISOString();
    const index = {
      files: { 'src/auth.ts': { mentions: 10, lastSeen: now } }
    };
    const entry = { content: 'Updated src/auth.ts' };
    const score = calculateEntityRelevanceScore(entry, index);
    // recency ~1.0, frequency = min(10/10, 1) = 1.0 → 0.6*1 + 0.4*1 = 1.0
    assert.ok(score > 0.9, `Expected high score for hot entity, got ${score}`);
  });

  it('scores lower for old entities', () => {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const index = {
      files: { 'src/auth.ts': { mentions: 10, lastSeen: monthAgo } }
    };
    const entry = { content: 'Updated src/auth.ts' };
    const score = calculateEntityRelevanceScore(entry, index);
    // recency ≈ 0 (30 days >> 24h half-life), frequency = 1.0 → ~0.4*1 = 0.4
    assert.ok(score < 0.5, `Expected low score for old entity, got ${score}`);
  });

  it('scores lower for infrequent entities', () => {
    const now = new Date().toISOString();
    const index = {
      files: { 'src/auth.ts': { mentions: 1, lastSeen: now } }
    };
    const entry = { content: 'Updated src/auth.ts' };
    const score = calculateEntityRelevanceScore(entry, index);
    // recency ~1.0, frequency = 1/10 = 0.1 → 0.6*1 + 0.4*0.1 = 0.64
    assert.ok(score > 0.6 && score < 0.7, `Expected ~0.64 for infrequent entity, got ${score}`);
  });

  it('averages across multiple entities', () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const index = {
      files: {
        'src/auth.ts': { mentions: 10, lastSeen: now },
        'src/db.ts': { mentions: 10, lastSeen: old },
      }
    };
    const entry = { content: 'Updated src/auth.ts and src/db.ts' };
    const score = calculateEntityRelevanceScore(entry, index);
    // One hot (~1.0) + one cold (~0.4) → average ~0.7
    assert.ok(score > 0.5 && score < 0.85, `Expected blended score, got ${score}`);
  });

  it('ignores entities not in the index', () => {
    const now = new Date().toISOString();
    const index = {
      files: { 'src/auth.ts': { mentions: 10, lastSeen: now } }
    };
    const entry = { content: 'Updated src/auth.ts and src/unknown.ts' };
    const score = calculateEntityRelevanceScore(entry, index);
    // Only src/auth.ts is in index, so score based on that alone
    assert.ok(score > 0.9, `Expected high score (unknown ignored), got ${score}`);
  });
});

// ============================================================================
// pruneEntityIndex
// ============================================================================

describe('pruneEntityIndex', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function daysAgo(n) {
    return new Date(Date.now() - n * DAY_MS).toISOString();
  }

  function makeEntity(lastSeen, mentions = 3) {
    return { mentions, lastSeen, contexts: [] };
  }

  it('removes entities older than maxAgeDays', () => {
    const index = {
      files: {
        'src/old.ts': makeEntity(daysAgo(60)),
        'src/fresh.ts': makeEntity(daysAgo(5)),
      },
      functions: {},
      errors: {},
      packages: {},
    };
    pruneEntityIndex(index, { maxAgeDays: 30 });
    assert.equal(index.files['src/old.ts'], undefined, 'Old entity should be pruned');
    assert.ok(index.files['src/fresh.ts'], 'Fresh entity should remain');
  });

  it('keeps entities within maxAgeDays', () => {
    const index = {
      files: {
        'src/recent.ts': makeEntity(daysAgo(10)),
        'src/borderline.ts': makeEntity(daysAgo(29)),
      },
      functions: {},
      errors: {},
      packages: {},
    };
    pruneEntityIndex(index, { maxAgeDays: 30 });
    assert.ok(index.files['src/recent.ts'], '10-day-old entity should survive 30-day cutoff');
    assert.ok(index.files['src/borderline.ts'], '29-day-old entity should survive 30-day cutoff');
  });

  it('prunes across all categories', () => {
    const index = {
      files: { 'src/old.ts': makeEntity(daysAgo(60)) },
      functions: { 'handleLogin': makeEntity(daysAgo(60)) },
      errors: { 'TypeError': makeEntity(daysAgo(60)) },
      packages: { 'lodash': makeEntity(daysAgo(60)) },
    };
    pruneEntityIndex(index, { maxAgeDays: 30 });
    assert.equal(Object.keys(index.files).length, 0);
    assert.equal(Object.keys(index.functions).length, 0);
    assert.equal(Object.keys(index.errors).length, 0);
    assert.equal(Object.keys(index.packages).length, 0);
  });

  it('removes entities with no lastSeen', () => {
    const index = {
      files: { 'src/ghost.ts': { mentions: 5, lastSeen: null, contexts: [] } },
      functions: {},
      errors: {},
      packages: {},
    };
    pruneEntityIndex(index, { maxAgeDays: 30 });
    assert.equal(index.files['src/ghost.ts'], undefined, 'Entity with null lastSeen should be pruned');
  });

  it('respects custom maxAgeDays', () => {
    const index = {
      files: {
        'src/a.ts': makeEntity(daysAgo(8)),
        'src/b.ts': makeEntity(daysAgo(3)),
      },
      functions: {},
      errors: {},
      packages: {},
    };
    pruneEntityIndex(index, { maxAgeDays: 7 });
    assert.equal(index.files['src/a.ts'], undefined, '8-day-old should be pruned with 7-day cutoff');
    assert.ok(index.files['src/b.ts'], '3-day-old should survive 7-day cutoff');
  });

  it('is disabled when maxAgeDays is 0', () => {
    const index = {
      files: { 'src/ancient.ts': makeEntity(daysAgo(365)) },
      functions: {},
      errors: {},
      packages: {},
    };
    pruneEntityIndex(index, { maxAgeDays: 0 });
    assert.ok(index.files['src/ancient.ts'], 'Nothing should be pruned when disabled');
    assert.equal(index.lastPruned, undefined, 'lastPruned should not be set when disabled');
  });

  it('is disabled when maxAgeDays is negative', () => {
    const index = {
      files: { 'src/old.ts': makeEntity(daysAgo(365)) },
      functions: {},
      errors: {},
      packages: {},
    };
    pruneEntityIndex(index, { maxAgeDays: -1 });
    assert.ok(index.files['src/old.ts'], 'Nothing should be pruned with negative maxAgeDays');
  });

  it('sets lastPruned timestamp after pruning', () => {
    const index = {
      files: {},
      functions: {},
      errors: {},
      packages: {},
    };
    const before = Date.now();
    pruneEntityIndex(index, { maxAgeDays: 30 });
    const after = Date.now();
    assert.ok(index.lastPruned, 'lastPruned should be set');
    const prunedTime = new Date(index.lastPruned).getTime();
    assert.ok(prunedTime >= before && prunedTime <= after, 'lastPruned should be roughly now');
  });

  it('skips pruning if already pruned within 24 hours', () => {
    const index = {
      files: { 'src/old.ts': makeEntity(daysAgo(60)) },
      functions: {},
      errors: {},
      packages: {},
      lastPruned: new Date().toISOString(), // just pruned
    };
    pruneEntityIndex(index, { maxAgeDays: 30 });
    assert.ok(index.files['src/old.ts'], 'Old entity should survive — daily guard prevents pruning');
  });

  it('prunes again after 24 hours have passed', () => {
    const index = {
      files: { 'src/old.ts': makeEntity(daysAgo(60)) },
      functions: {},
      errors: {},
      packages: {},
      lastPruned: daysAgo(2), // pruned 2 days ago
    };
    pruneEntityIndex(index, { maxAgeDays: 30 });
    assert.equal(index.files['src/old.ts'], undefined, 'Old entity should be pruned after guard expires');
  });

  it('uses default maxAgeDays of 30 when not configured', () => {
    const index = {
      files: {
        'src/old.ts': makeEntity(daysAgo(31)),
        'src/fresh.ts': makeEntity(daysAgo(29)),
      },
      functions: {},
      errors: {},
      packages: {},
    };
    pruneEntityIndex(index); // no config
    assert.equal(index.files['src/old.ts'], undefined, '31-day-old should be pruned by default');
    assert.ok(index.files['src/fresh.ts'], '29-day-old should survive default cutoff');
  });

  it('does not touch metadata keys stored alongside categories', () => {
    const index = {
      files: { 'src/fresh.ts': makeEntity(daysAgo(1)) },
      functions: {},
      errors: {},
      packages: {},
      lastUpdated: '2025-01-01T00:00:00Z',
    };
    pruneEntityIndex(index, { maxAgeDays: 30 });
    assert.equal(index.lastUpdated, '2025-01-01T00:00:00Z', 'lastUpdated metadata should be untouched');
    assert.ok(index.lastPruned, 'lastPruned should be set');
  });

  it('handles missing categories gracefully', () => {
    const index = { files: { 'src/old.ts': makeEntity(daysAgo(60)) } };
    // No functions/errors/packages keys at all
    pruneEntityIndex(index, { maxAgeDays: 30 });
    assert.equal(index.files['src/old.ts'], undefined, 'Should prune even with missing categories');
  });
});

// ============================================================================
// extractFilePaths
// ============================================================================

describe('extractFilePaths', () => {
  const e = (content) => ({ content });

  it('extracts relative paths with directories', () => {
    const paths = extractFilePaths(e('Updated src/auth.ts and lib/utils.mjs'));
    assert.ok(paths.includes('src/auth.ts'));
    assert.ok(paths.includes('lib/utils.mjs'));
  });

  it('extracts deeply nested paths', () => {
    const paths = extractFilePaths(e('Changed src/components/auth/Login.tsx'));
    assert.ok(paths.includes('src/components/auth/Login.tsx'));
  });

  it('extracts backtick-wrapped files', () => {
    const paths = extractFilePaths(e('Check `config.json` and `src/index.ts` for details'));
    assert.ok(paths.includes('config.json'));
    assert.ok(paths.includes('src/index.ts'));
  });

  it('extracts files after keywords', () => {
    const paths = extractFilePaths(e('Updated file utils.mjs and created test.ts'));
    assert.ok(paths.includes('utils.mjs'), `Expected utils.mjs in ${JSON.stringify(paths)}`);
    assert.ok(paths.includes('test.ts'), `Expected test.ts in ${JSON.stringify(paths)}`);
  });

  it('extracts standalone filenames with common extensions', () => {
    const paths = extractFilePaths(e('Look at package.json for the config'));
    assert.ok(paths.includes('package.json'), `Expected package.json in ${JSON.stringify(paths)}`);
  });

  it('deduplicates paths', () => {
    const paths = extractFilePaths(e('Updated src/auth.ts then reviewed src/auth.ts again'));
    assert.equal(paths.filter(p => p === 'src/auth.ts').length, 1);
  });

  it('ignores paths with unrecognized extensions', () => {
    const paths = extractFilePaths(e('Opened src/data.xyz'));
    assert.ok(!paths.includes('src/data.xyz'));
  });

  it('ignores very long paths (>=100 chars)', () => {
    const longPath = 'src/' + 'a'.repeat(93) + '.ts'; // 4 + 93 + 3 = 100 chars
    const paths = extractFilePaths(e(`Changed ${longPath}`));
    assert.equal(paths.length, 0);
  });

  it('returns empty for content with no file references', () => {
    const paths = extractFilePaths(e('Just a normal sentence without files'));
    assert.equal(paths.length, 0);
  });

  it('reads from subject when content is empty', () => {
    const paths = extractFilePaths({ subject: 'Fix bug in src/main.ts' });
    assert.ok(paths.includes('src/main.ts'));
  });

  it('respects custom fileExtensions config', () => {
    const paths = extractFilePaths(e('Changed src/style.css and src/app.tsx'), {
      fileExtensions: ['tsx'],
    });
    assert.ok(paths.includes('src/app.tsx'));
    assert.ok(!paths.includes('src/style.css'), 'css not in custom extension list');
  });

  it('filters out version-number false positives', () => {
    // isFileFalsePositive catches "1.0.0.js"-like patterns
    const paths = extractFilePaths(e('Version 2.0.js is out'));
    assert.ok(!paths.some(p => p.includes('2.0')), `Version-like path should be filtered: ${JSON.stringify(paths)}`);
  });
});

// ============================================================================
// isFileFalsePositive
// ============================================================================

describe('isFileFalsePositive', () => {
  it('rejects version-number patterns', () => {
    assert.equal(isFileFalsePositive('1.0.0.js'), true);
    assert.equal(isFileFalsePositive('2.3.js'), true);
  });

  it('rejects URLs', () => {
    assert.equal(isFileFalsePositive('http://example.com'), true);
    assert.equal(isFileFalsePositive('https://foo.bar'), true);
    assert.equal(isFileFalsePositive('www.example.com'), true);
  });

  it('rejects error-message false positives', () => {
    assert.equal(isFileFalsePositive('read.property'), true);
    assert.equal(isFileFalsePositive('of.undefined'), true);
    assert.equal(isFileFalsePositive('some.property.access'), true);
  });

  it('accepts valid file paths', () => {
    assert.equal(isFileFalsePositive('src/auth.ts'), false);
    assert.equal(isFileFalsePositive('utils.mjs'), false);
    assert.equal(isFileFalsePositive('package.json'), false);
    assert.equal(isFileFalsePositive('README.md'), false);
  });

  it('is case-insensitive for false positive words', () => {
    assert.equal(isFileFalsePositive('Read.Property'), true);
    assert.equal(isFileFalsePositive('OF.UNDEFINED'), true);
  });
});

// ============================================================================
// extractFunctionNames
// ============================================================================

describe('extractFunctionNames', () => {
  const e = (content) => ({ content });

  it('extracts standard function declarations', () => {
    const fns = extractFunctionNames(e('function handleLogin() { ... }'));
    assert.ok(fns.includes('handleLogin'), `Expected handleLogin in ${JSON.stringify(fns)}`);
  });

  it('extracts arrow function assignments', () => {
    const fns = extractFunctionNames(e('const processData = (items) => { ... }'));
    assert.ok(fns.includes('processData'), `Expected processData in ${JSON.stringify(fns)}`);
  });

  it('extracts backtick-wrapped function calls', () => {
    const fns = extractFunctionNames(e('Call `handleLogin()` to start'));
    assert.ok(fns.includes('handleLogin'), `Expected handleLogin in ${JSON.stringify(fns)}`);
  });

  it('extracts "method/function X" pattern with camelCase', () => {
    // Pattern requires keyword BEFORE the name: "method handleLogin", not "handleLogin function"
    const fns = extractFunctionNames(e('the method handleLogin is broken'));
    assert.ok(fns.includes('handleLogin'), `Expected handleLogin in ${JSON.stringify(fns)}`);
  });

  it('extracts Python def statements', () => {
    const fns = extractFunctionNames(e('def handle_request(req):'));
    assert.ok(fns.includes('handle_request'), `Expected handle_request in ${JSON.stringify(fns)}`);
  });

  it('excludes JavaScript keywords', () => {
    const fns = extractFunctionNames(e('function if() {} function return() {}'));
    assert.ok(!fns.includes('if'));
    assert.ok(!fns.includes('return'));
  });

  it('excludes built-in objects and common methods', () => {
    const fns = extractFunctionNames(e('`console()` and `Array()` and `forEach()`'));
    assert.ok(!fns.includes('console'));
    assert.ok(!fns.includes('Array'));
    assert.ok(!fns.includes('forEach'));
  });

  it('requires mixed case or underscore for short names', () => {
    // "foo" is all-lowercase, 3 chars, no underscore → excluded
    const fns = extractFunctionNames(e('function foo() {} function fooBar() {}'));
    assert.ok(!fns.includes('foo'), 'Short all-lowercase name should be excluded');
    assert.ok(fns.includes('fooBar'), 'camelCase name should be included');
  });

  it('allows longer all-lowercase names (>=6 chars)', () => {
    const fns = extractFunctionNames(e('function foobar() {} function bazqux() {}'));
    // 6-char all-lowercase passes the length >= 6 check
    assert.ok(fns.includes('foobar'), `Expected foobar in ${JSON.stringify(fns)}`);
    assert.ok(fns.includes('bazqux'), `Expected bazqux in ${JSON.stringify(fns)}`);
  });

  it('returns empty for content with no function references', () => {
    const fns = extractFunctionNames(e('Just a normal sentence'));
    assert.equal(fns.length, 0);
  });

  it('deduplicates function names', () => {
    const fns = extractFunctionNames(e('function handleLogin() {} called `handleLogin()`'));
    assert.equal(fns.filter(f => f === 'handleLogin').length, 1);
  });

  it('respects minEntityLength from config', () => {
    const fns = extractFunctionNames(e('function handleLogin() {}'), { minEntityLength: 20 });
    assert.equal(fns.length, 0, 'handleLogin is <20 chars');
  });
});

// ============================================================================
// extractErrorMessages
// ============================================================================

describe('extractErrorMessages', () => {
  const e = (content) => ({ content });

  it('extracts TypeError', () => {
    const errors = extractErrorMessages(e('TypeError: Cannot read properties of null'));
    assert.ok(errors.some(e => e.includes('TypeError')), `Expected TypeError in ${JSON.stringify(errors)}`);
    assert.ok(errors.some(e => e.includes('Cannot read')));
  });

  it('extracts ReferenceError', () => {
    const errors = extractErrorMessages(e('ReferenceError: foo is not defined'));
    assert.ok(errors.some(e => e.includes('ReferenceError')));
    assert.ok(errors.some(e => e.includes('foo is not defined')));
  });

  it('extracts SyntaxError', () => {
    const errors = extractErrorMessages(e('SyntaxError: Unexpected token }'));
    assert.ok(errors.some(e => e.includes('SyntaxError')));
  });

  it('extracts plain Error', () => {
    const errors = extractErrorMessages(e('Error: ENOENT no such file or directory'));
    assert.ok(errors.some(e => e.includes('ENOENT')));
  });

  it('extracts "error:" prefix (case insensitive)', () => {
    const errors = extractErrorMessages(e('error: connection refused on port 5432'));
    assert.ok(errors.some(e => e.includes('connection refused')), `Expected match in ${JSON.stringify(errors)}`);
  });

  it('extracts "failed:" pattern', () => {
    const errors = extractErrorMessages(e('failed: to compile module src/main.ts'));
    assert.ok(errors.some(e => e.includes('compile module')), `Expected match in ${JSON.stringify(errors)}`);
  });

  it('extracts stack trace first lines', () => {
    const errors = extractErrorMessages(e('  at Module._compile (node:internal/modules/cjs/loader:1234:56)'));
    assert.ok(errors.length > 0, 'Should extract stack trace line');
  });

  it('caps error messages at 100 chars', () => {
    const longMsg = 'TypeError: ' + 'x'.repeat(200);
    const errors = extractErrorMessages(e(longMsg));
    for (const err of errors) {
      assert.ok(err.length <= 100, `Error should be <=100 chars, got ${err.length}`);
    }
  });

  it('returns empty for content with no errors', () => {
    const errors = extractErrorMessages(e('Everything worked perfectly'));
    assert.equal(errors.length, 0);
  });

  it('deduplicates identical error messages', () => {
    const errors = extractErrorMessages(e('TypeError: foo bar\nTypeError: foo bar'));
    assert.equal(errors.filter(e => e.includes('foo bar')).length, 1);
  });

  it('ignores too-short error messages', () => {
    // "error: ab" — message "ab" is only 2 chars, but the pattern requires >=5 chars
    const errors = extractErrorMessages(e('error: ab'));
    assert.equal(errors.length, 0, 'Very short error messages should be ignored');
  });
});

// ============================================================================
// extractPackageNames
// ============================================================================

describe('extractPackageNames', () => {
  const e = (content) => ({ content });

  it('extracts from npm install command', () => {
    const pkgs = extractPackageNames(e('npm install express lodash'));
    assert.ok(pkgs.includes('express'), `Expected express in ${JSON.stringify(pkgs)}`);
    assert.ok(pkgs.includes('lodash'), `Expected lodash in ${JSON.stringify(pkgs)}`);
  });

  it('extracts from yarn add', () => {
    const pkgs = extractPackageNames(e('yarn add react react-dom'));
    assert.ok(pkgs.includes('react'));
    assert.ok(pkgs.includes('react-dom'));
  });

  it('extracts scoped packages', () => {
    const pkgs = extractPackageNames(e("import sdk from '@anthropic-ai/sdk'"));
    assert.ok(pkgs.includes('@anthropic-ai/sdk'), `Expected scoped pkg in ${JSON.stringify(pkgs)}`);
  });

  it('extracts from ES import statements', () => {
    const pkgs = extractPackageNames(e("import express from 'express'"));
    assert.ok(pkgs.includes('express'));
  });

  it('extracts from require calls', () => {
    const pkgs = extractPackageNames(e("const z = require('zod')"));
    assert.ok(pkgs.includes('zod'));
  });

  it('extracts from pip install', () => {
    const pkgs = extractPackageNames(e('pip install requests'));
    assert.ok(pkgs.includes('requests'));
  });

  it('strips version specifiers without dots', () => {
    const pkgs = extractPackageNames(e('npm install express@5 lodash@4'));
    assert.ok(pkgs.includes('express'), 'Should strip @5');
    assert.ok(pkgs.includes('lodash'), 'Should strip @4');
  });

  it('strips dotted version specifiers from install commands', () => {
    const pkgs = extractPackageNames(e('npm install express@^5.0.0 lodash@4.17.21'));
    assert.ok(pkgs.includes('express'), 'Should extract express');
    assert.ok(pkgs.includes('lodash'), 'Should extract lodash');
    assert.ok(!pkgs.some(p => p.includes('@')), 'Version specifiers should be stripped');
  });

  it('ignores npm flags', () => {
    const pkgs = extractPackageNames(e('npm install --save-dev jest -D typescript'));
    assert.ok(!pkgs.some(p => p.startsWith('-')));
  });

  it('excludes Node.js built-in modules', () => {
    const pkgs = extractPackageNames(e("require('fs') and require('path') and require('crypto')"));
    assert.ok(!pkgs.includes('fs'));
    assert.ok(!pkgs.includes('path'));
    assert.ok(!pkgs.includes('crypto'));
  });

  it('excludes common relative-import directory names', () => {
    const pkgs = extractPackageNames(e("import foo from 'utils'"));
    assert.ok(!pkgs.includes('utils'));
  });

  it('excludes relative paths', () => {
    const pkgs = extractPackageNames(e("import x from './local'"));
    assert.ok(!pkgs.includes('./local'));
  });

  it('deduplicates package names', () => {
    const pkgs = extractPackageNames(e("npm install express\nimport x from 'express'"));
    assert.equal(pkgs.filter(p => p === 'express').length, 1);
  });

  it('returns empty for content with no packages', () => {
    const pkgs = extractPackageNames(e('No packages mentioned here'));
    assert.equal(pkgs.length, 0);
  });

  it('extracts backtick-wrapped scoped packages', () => {
    const pkgs = extractPackageNames(e('Using `@anthropic-ai/sdk` for the API'));
    assert.ok(pkgs.includes('@anthropic-ai/sdk'));
  });
});

// ============================================================================
// isValidPackageName
// ============================================================================

describe('isValidPackageName', () => {
  it('accepts normal package names', () => {
    assert.equal(isValidPackageName('express'), true);
    assert.equal(isValidPackageName('lodash'), true);
    assert.equal(isValidPackageName('react-dom'), true);
  });

  it('accepts scoped packages', () => {
    assert.equal(isValidPackageName('@anthropic-ai/sdk'), true);
  });

  it('rejects relative paths', () => {
    assert.equal(isValidPackageName('./local'), false);
    assert.equal(isValidPackageName('../parent'), false);
    assert.equal(isValidPackageName('/absolute'), false);
  });

  it('rejects Node.js built-ins', () => {
    assert.equal(isValidPackageName('fs'), false);
    assert.equal(isValidPackageName('path'), false);
    assert.equal(isValidPackageName('crypto'), false);
    assert.equal(isValidPackageName('child_process'), false);
  });

  it('rejects common directory names', () => {
    assert.equal(isValidPackageName('src'), false);
    assert.equal(isValidPackageName('lib'), false);
    assert.equal(isValidPackageName('utils'), false);
    assert.equal(isValidPackageName('components'), false);
  });

  it('rejects names too short', () => {
    assert.equal(isValidPackageName('a'), false);
    assert.equal(isValidPackageName('', 2), false);
  });

  it('rejects names too long (>=60)', () => {
    assert.equal(isValidPackageName('a'.repeat(60)), false);
  });

  it('rejects null/undefined', () => {
    assert.equal(isValidPackageName(null), false);
    assert.equal(isValidPackageName(undefined), false);
  });

  it('respects custom minLength', () => {
    assert.equal(isValidPackageName('ab', 3), false);
    assert.equal(isValidPackageName('abc', 3), true);
  });
});

// ============================================================================
// stripMarkdown
// ============================================================================

describe('stripMarkdown', () => {
  it('returns empty/null input unchanged', () => {
    assert.equal(stripMarkdown(''), '');
    assert.equal(stripMarkdown(null), null);
    assert.equal(stripMarkdown(undefined), undefined);
  });

  it('passes plain text through unchanged', () => {
    assert.equal(stripMarkdown('Hello world'), 'Hello world');
  });

  it('strips bold markers', () => {
    assert.equal(stripMarkdown('This is **bold** text'), 'This is bold text');
  });

  it('strips italic markers', () => {
    assert.equal(stripMarkdown('This is *italic* text'), 'This is italic text');
  });

  it('strips inline backticks', () => {
    assert.equal(
      stripMarkdown('Fixed `lib.rs`, `main.rs` formatting'),
      'Fixed lib.rs, main.rs formatting'
    );
  });

  it('strips code block fences', () => {
    assert.equal(
      stripMarkdown('```js\nconst x = 1;\n```'),
      'const x = 1;'
    );
  });

  it('strips headers', () => {
    assert.equal(stripMarkdown('## Summary\nSome text'), 'Summary\nSome text');
    assert.equal(stripMarkdown('### Details'), 'Details');
  });

  it('strips links, keeps text', () => {
    assert.equal(
      stripMarkdown('See [the docs](https://example.com) for details'),
      'See the docs for details'
    );
  });

  it('strips images', () => {
    assert.equal(
      stripMarkdown('Here: ![logo](https://img.png) done'),
      'Here:  done'
    );
  });

  it('strips block quotes', () => {
    assert.equal(stripMarkdown('> Note: something important'), 'Note: something important');
  });

  it('strips bullet markers', () => {
    assert.equal(stripMarkdown('- First item\n- Second item'), 'First item\nSecond item');
    assert.equal(stripMarkdown('* First\n* Second'), 'First\nSecond');
  });

  it('strips numbered list markers', () => {
    assert.equal(stripMarkdown('1. First\n2. Second'), 'First\nSecond');
  });

  it('strips checkboxes', () => {
    assert.equal(stripMarkdown('- [x] Done task\n- [ ] Todo task'), 'Done task\nTodo task');
  });

  it('strips strikethrough', () => {
    assert.equal(stripMarkdown('~~old text~~ new text'), 'old text new text');
  });

  it('strips horizontal rules', () => {
    assert.equal(stripMarkdown('Above\n---\nBelow'), 'Above\n\nBelow');
  });

  it('strips emoji', () => {
    assert.equal(stripMarkdown('Thanks! 👋'), 'Thanks!');
    assert.equal(stripMarkdown('Great work 🎉🚀'), 'Great work');
  });

  it('strips HTML tags', () => {
    assert.equal(stripMarkdown('text<br>more<details>hidden</details>'), 'textmorehidden');
  });

  it('collapses excessive blank lines', () => {
    assert.equal(stripMarkdown('A\n\n\n\nB'), 'A\n\nB');
  });

  it('preserves hyphens in filenames and words', () => {
    assert.equal(stripMarkdown('Updated my-file.rs and stop-capture.mjs'), 'Updated my-file.rs and stop-capture.mjs');
  });

  it('handles a realistic response', () => {
    const input = 'Fixed. Three long lines in `lib.rs`, `main.rs`, and a couple in `cache.rs`/`typosquat.rs` that `cargo fmt` wanted wrapped. Should be green now.';
    const expected = 'Fixed. Three long lines in lib.rs, main.rs, and a couple in cache.rs/typosquat.rs that cargo fmt wanted wrapped. Should be green now.';
    assert.equal(stripMarkdown(input), expected);
  });

  it('handles a realistic agent response', () => {
    const input = 'Thanks, it was a good one! Enjoy the evening. 👋';
    const expected = 'Thanks, it was a good one! Enjoy the evening.';
    assert.equal(stripMarkdown(input), expected);
  });

  it('handles combined formatting', () => {
    const input = '## Summary\n\n- **Fixed** the `auth` bug\n- Updated [docs](https://x.com)\n\n---\n\n> Note: needs review 🔍';
    const result = stripMarkdown(input);
    assert.ok(!result.includes('##'));
    assert.ok(!result.includes('**'));
    assert.ok(!result.includes('`'));
    assert.ok(!result.includes(']('));
    assert.ok(!result.includes('---'));
    assert.ok(!result.includes('>'));
    assert.ok(!result.includes('🔍'));
    assert.ok(result.includes('Fixed'));
    assert.ok(result.includes('auth'));
    assert.ok(result.includes('docs'));
    assert.ok(result.includes('needs review'));
  });
});

// ============================================================================
// getProjectRoot
// ============================================================================

describe('getProjectRoot', () => {
  it('returns an absolute path', () => {
    const root = getProjectRoot();
    assert.ok(root.startsWith('/'), `Expected absolute path, got ${root}`);
  });

  it('returns git root when inside a git repo', () => {
    // We're running from inside the claude-mneme repo
    const root = getProjectRoot();
    assert.ok(root.endsWith('claude-mneme'), `Expected git root ending in claude-mneme, got ${root}`);
  });

  it('returns cwd for non-git directories', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mneme-root-'));
    try {
      const root = getProjectRoot(tmp);
      assert.equal(root, tmp, 'Should return cwd for non-git dir');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// getProjectName (display name — basename only)
// ============================================================================

describe('getProjectName', () => {
  it('returns basename of git root', () => {
    const name = getProjectName();
    assert.equal(name, 'claude-mneme');
  });
});

// ============================================================================
// getProjectMemoryDir (full-path-based naming + migration)
// ============================================================================

describe('ensureMemoryDirs (full-path naming + migration)', () => {
  it('creates dir with full-path-based name', () => {
    const paths = ensureMemoryDirs();
    // Should contain the full path sanitized, not just basename
    assert.ok(paths.project.includes('-home-') || paths.project.includes('-Users-'),
      `Expected full-path dir name, got ${paths.project}`);
    assert.ok(!paths.project.endsWith('/projects/claude-mneme'),
      `Should NOT be old-style basename-only dir: ${paths.project}`);
  });

  it('migrates old-style dir to new-style dir', () => {
    // Create a temp directory to simulate a project root
    const tmp = mkdtempSync(join(tmpdir(), 'mneme-migrate-'));
    const projectsDir = join(MEMORY_BASE, 'projects');

    // Derive what old-style and new-style names would be for this temp dir
    const oldName = tmp.split('/').pop().replace(/[^a-zA-Z0-9_-]/g, '_');
    const newName = tmp.replace(/^\//, '-').replace(/\//g, '-');
    const oldDir = join(projectsDir, oldName);
    const newDir = join(projectsDir, newName);

    try {
      // Clean up any pre-existing dirs
      if (existsSync(newDir)) rmSync(newDir, { recursive: true, force: true });
      if (existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });

      // Create old-style dir with a marker file
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(join(oldDir, 'marker.txt'), 'migrated');

      // Call ensureMemoryDirs — should migrate old → new
      const paths = ensureMemoryDirs(tmp);

      assert.ok(existsSync(newDir), 'New-style dir should exist after migration');
      assert.ok(!existsSync(oldDir), 'Old-style dir should be gone after migration');
      assert.ok(existsSync(join(newDir, 'marker.txt')), 'Marker file should survive migration');
      assert.equal(paths.project, newDir);
    } finally {
      // Clean up
      if (existsSync(newDir)) rmSync(newDir, { recursive: true, force: true });
      if (existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not migrate if new-style dir already exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mneme-nomigrate-'));
    const projectsDir = join(MEMORY_BASE, 'projects');

    const oldName = tmp.split('/').pop().replace(/[^a-zA-Z0-9_-]/g, '_');
    const newName = tmp.replace(/^\//, '-').replace(/\//g, '-');
    const oldDir = join(projectsDir, oldName);
    const newDir = join(projectsDir, newName);

    try {
      if (existsSync(newDir)) rmSync(newDir, { recursive: true, force: true });
      if (existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });

      // Create BOTH dirs
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(join(oldDir, 'old-marker.txt'), 'old');
      mkdirSync(newDir, { recursive: true });
      writeFileSync(join(newDir, 'new-marker.txt'), 'new');

      ensureMemoryDirs(tmp);

      // Old dir should still exist (no migration attempted)
      assert.ok(existsSync(oldDir), 'Old dir should remain when new dir already exists');
      assert.ok(existsSync(join(newDir, 'new-marker.txt')), 'New dir contents should be untouched');
    } finally {
      if (existsSync(newDir)) rmSync(newDir, { recursive: true, force: true });
      if (existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
