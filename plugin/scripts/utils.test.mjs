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
