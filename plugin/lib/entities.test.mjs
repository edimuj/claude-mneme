import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  extractFilePaths,
  isFileFalsePositive,
  extractFunctionNames,
  extractErrorMessages,
  extractPackageNames,
  isValidPackageName,
  extractEntitiesFromEntry,
  emptyEntityIndex,
  loadEntityIndex,
  pruneEntityIndex,
  truncateContext,
  applyExtractedEntitiesToIndex,
  writeEntityIndex,
  updateEntityIndexBatch,
  updateEntityIndex,
  calculateRecencyScore,
  calculateEntityRelevanceScore,
} from './entities.mjs';

// ---------------------------------------------------------------------------
// extractFilePaths
// ---------------------------------------------------------------------------

describe('extractFilePaths', () => {
  it('extracts paths with directory separators', () => {
    const entry = { content: 'Updated src/auth.ts and lib/utils.mjs' };
    const paths = extractFilePaths(entry);
    assert.ok(paths.includes('src/auth.ts'));
    assert.ok(paths.includes('lib/utils.mjs'));
  });

  it('extracts backtick-quoted paths', () => {
    const entry = { content: 'Changed `config.json` to fix the issue' };
    const paths = extractFilePaths(entry);
    assert.ok(paths.includes('config.json'));
  });

  it('extracts paths from "file" keyword context', () => {
    const entry = { content: 'edit server/routes.ts to add endpoint' };
    const paths = extractFilePaths(entry);
    assert.ok(paths.includes('server/routes.ts'));
  });

  it('extracts bare filenames with known extensions', () => {
    const entry = { content: 'Fixed index.ts and app.vue' };
    const paths = extractFilePaths(entry);
    assert.ok(paths.includes('index.ts'));
    assert.ok(paths.includes('app.vue'));
  });

  it('deduplicates paths', () => {
    const entry = { content: 'src/auth.ts was in `src/auth.ts` and also from src/auth.ts' };
    const paths = extractFilePaths(entry);
    const authCount = paths.filter(p => p === 'src/auth.ts').length;
    assert.equal(authCount, 1);
  });

  it('rejects paths longer than 100 chars', () => {
    const longPath = 'a/'.repeat(50) + 'file.ts';
    const entry = { content: longPath };
    const paths = extractFilePaths(entry);
    assert.ok(!paths.some(p => p.length >= 100));
  });

  it('rejects paths with unrecognized extensions', () => {
    const entry = { content: 'look at file.xyz and binary.exe' };
    const paths = extractFilePaths(entry);
    assert.equal(paths.length, 0);
  });

  it('filters false positives', () => {
    const entry = { content: 'version 2.1.0 released, check http://example.com/api.js' };
    const paths = extractFilePaths(entry);
    assert.ok(!paths.some(p => p.startsWith('2.1')));
    assert.ok(!paths.some(p => p.includes('http')));
  });

  it('reads from subject when content is missing', () => {
    const entry = { subject: 'Updated src/utils.mjs' };
    const paths = extractFilePaths(entry);
    assert.ok(paths.includes('src/utils.mjs'));
  });

  it('respects custom fileExtensions config', () => {
    const entry = { content: 'edit src/app.custom and src/main.ts' };
    const paths = extractFilePaths(entry, { fileExtensions: ['custom'] });
    assert.ok(paths.includes('src/app.custom'));
    assert.ok(!paths.includes('src/main.ts'));
  });

  it('returns empty array for empty content', () => {
    assert.deepEqual(extractFilePaths({}), []);
    assert.deepEqual(extractFilePaths({ content: '' }), []);
  });
});

// ---------------------------------------------------------------------------
// isFileFalsePositive
// ---------------------------------------------------------------------------

describe('isFileFalsePositive', () => {
  it('rejects version-like strings', () => {
    assert.ok(isFileFalsePositive('2.1.0'));
    assert.ok(isFileFalsePositive('10.3.patch'));
  });

  it('rejects URLs', () => {
    assert.ok(isFileFalsePositive('http://example.com'));
    assert.ok(isFileFalsePositive('https://foo.bar'));
    assert.ok(isFileFalsePositive('www.example.com'));
  });

  it('rejects error-like strings', () => {
    assert.ok(isFileFalsePositive('property.of.undefined'));
    assert.ok(isFileFalsePositive('read.property'));
  });

  it('accepts valid file paths', () => {
    assert.ok(!isFileFalsePositive('src/auth.ts'));
    assert.ok(!isFileFalsePositive('package.json'));
    assert.ok(!isFileFalsePositive('lib/entities.mjs'));
  });
});

// ---------------------------------------------------------------------------
// extractFunctionNames
// ---------------------------------------------------------------------------

describe('extractFunctionNames', () => {
  it('extracts function declarations', () => {
    const entry = { content: 'function calculateScore(args) { }' };
    const fns = extractFunctionNames(entry);
    assert.ok(fns.includes('calculateScore'));
  });

  it('extracts const arrow functions', () => {
    const entry = { content: 'const handleRequest = async (req) => { }' };
    const fns = extractFunctionNames(entry);
    assert.ok(fns.includes('handleRequest'));
  });

  it('extracts backtick-referenced functions', () => {
    const entry = { content: 'Called `parseConfig()` to load settings' };
    const fns = extractFunctionNames(entry);
    assert.ok(fns.includes('parseConfig'));
  });

  it('extracts Python-style defs', () => {
    const entry = { content: 'def calculate_score(items):' };
    const fns = extractFunctionNames(entry);
    assert.ok(fns.includes('calculate_score'));
  });

  it('excludes common keywords', () => {
    const entry = { content: 'function if(x) { }' };
    const fns = extractFunctionNames(entry);
    assert.ok(!fns.includes('if'));
  });

  it('excludes short generic names without uppercase or underscore', () => {
    // Names need uppercase, underscore, or length >= 6 to pass
    const entry = { content: '`foo()` and `bar()`' };
    const fns = extractFunctionNames(entry);
    assert.ok(!fns.includes('foo'));
    assert.ok(!fns.includes('bar'));
  });

  it('accepts camelCase names', () => {
    const entry = { content: '`getData()` was called' };
    const fns = extractFunctionNames(entry);
    assert.ok(fns.includes('getData'));
  });

  it('returns empty array for empty content', () => {
    assert.deepEqual(extractFunctionNames({}), []);
  });
});

// ---------------------------------------------------------------------------
// extractErrorMessages
// ---------------------------------------------------------------------------

describe('extractErrorMessages', () => {
  it('extracts TypeError with message', () => {
    const entry = { content: 'TypeError: Cannot read properties of undefined' };
    const errors = extractErrorMessages(entry);
    assert.ok(errors.some(e => e.includes('TypeError')));
    assert.ok(errors.some(e => e.includes('Cannot read properties')));
  });

  it('extracts ReferenceError', () => {
    const entry = { content: 'ReferenceError: foo is not defined' };
    const errors = extractErrorMessages(entry);
    assert.ok(errors.some(e => e.includes('ReferenceError')));
  });

  it('extracts generic error: prefix', () => {
    const entry = { content: 'error: ENOENT no such file or directory' };
    const errors = extractErrorMessages(entry);
    assert.ok(errors.length > 0);
  });

  it('extracts failure messages', () => {
    const entry = { content: 'failed: connection timed out after 30 seconds' };
    const errors = extractErrorMessages(entry);
    assert.ok(errors.length > 0);
  });

  it('extracts stack trace lines', () => {
    const entry = { content: '  at Object.method (/path/to/file.js:42:10)' };
    const errors = extractErrorMessages(entry);
    assert.ok(errors.some(e => e.includes('Object.method')));
  });

  it('limits error length to 100 chars', () => {
    const long = 'TypeError: ' + 'x'.repeat(200);
    const entry = { content: long };
    const errors = extractErrorMessages(entry);
    for (const e of errors) {
      assert.ok(e.length <= 100);
    }
  });

  it('returns empty for content without errors', () => {
    const entry = { content: 'Everything works fine, no issues at all' };
    assert.deepEqual(extractErrorMessages(entry), []);
  });
});

// ---------------------------------------------------------------------------
// extractPackageNames
// ---------------------------------------------------------------------------

describe('extractPackageNames', () => {
  it('extracts from npm install commands', () => {
    const entry = { content: 'npm install express lodash' };
    const pkgs = extractPackageNames(entry);
    assert.ok(pkgs.includes('express'));
    assert.ok(pkgs.includes('lodash'));
  });

  it('extracts scoped packages from imports', () => {
    const entry = { content: "import { query } from '@anthropic-ai/claude-agent-sdk'" };
    const pkgs = extractPackageNames(entry);
    assert.ok(pkgs.includes('@anthropic-ai/claude-agent-sdk'));
  });

  it('extracts from require calls', () => {
    const entry = { content: "const x = require('chalk')" };
    const pkgs = extractPackageNames(entry);
    assert.ok(pkgs.includes('chalk'));
  });

  it('strips version suffixes from install commands', () => {
    const entry = { content: 'npm install express@^4.18.0' };
    const pkgs = extractPackageNames(entry);
    assert.ok(pkgs.includes('express'));
    assert.ok(!pkgs.some(p => p.includes('@')));
  });

  it('extracts from pip install', () => {
    const entry = { content: 'pip install requests' };
    const pkgs = extractPackageNames(entry);
    assert.ok(pkgs.includes('requests'));
  });

  it('extracts backtick-quoted scoped packages', () => {
    const entry = { content: 'Using `@types/node` for definitions' };
    const pkgs = extractPackageNames(entry);
    assert.ok(pkgs.includes('@types/node'));
  });

  it('excludes Node built-in modules', () => {
    const entry = { content: "import { readFile } from 'fs'" };
    const pkgs = extractPackageNames(entry);
    assert.ok(!pkgs.includes('fs'));
  });

  it('excludes relative paths', () => {
    const entry = { content: "import foo from './utils'" };
    const pkgs = extractPackageNames(entry);
    assert.ok(!pkgs.includes('./utils'));
  });

  it('excludes common directory names', () => {
    const entry = { content: "import foo from 'src'" };
    const pkgs = extractPackageNames(entry);
    assert.ok(!pkgs.includes('src'));
  });
});

// ---------------------------------------------------------------------------
// isValidPackageName
// ---------------------------------------------------------------------------

describe('isValidPackageName', () => {
  it('accepts normal package names', () => {
    assert.ok(isValidPackageName('express'));
    assert.ok(isValidPackageName('lodash'));
    assert.ok(isValidPackageName('chalk'));
  });

  it('rejects Node built-ins', () => {
    assert.ok(!isValidPackageName('fs'));
    assert.ok(!isValidPackageName('path'));
    assert.ok(!isValidPackageName('crypto'));
  });

  it('rejects relative paths', () => {
    assert.ok(!isValidPackageName('./foo'));
    assert.ok(!isValidPackageName('../bar'));
    assert.ok(!isValidPackageName('/absolute'));
  });

  it('rejects names too short', () => {
    assert.ok(!isValidPackageName('x'));
    assert.ok(!isValidPackageName('a', 2));
  });

  it('rejects names too long (>= 60)', () => {
    assert.ok(!isValidPackageName('a'.repeat(60)));
  });

  it('rejects common directory names', () => {
    assert.ok(!isValidPackageName('src'));
    assert.ok(!isValidPackageName('lib'));
    assert.ok(!isValidPackageName('dist'));
    assert.ok(!isValidPackageName('test'));
  });
});

// ---------------------------------------------------------------------------
// extractEntitiesFromEntry
// ---------------------------------------------------------------------------

describe('extractEntitiesFromEntry', () => {
  it('extracts all categories by default', () => {
    const entry = {
      content: 'Updated src/auth.ts, function parseToken(), npm install zod, TypeError: oops bad thing'
    };
    const result = extractEntitiesFromEntry(entry);
    assert.ok(result.files?.length > 0);
    assert.ok(result.functions?.length > 0);
    assert.ok(result.packages?.length > 0);
    assert.ok(result.errors?.length > 0);
  });

  it('respects disabled categories', () => {
    const entry = { content: 'Updated src/auth.ts and parseToken()' };
    const result = extractEntitiesFromEntry(entry, {
      categories: { files: true, functions: false, errors: false, packages: false }
    });
    assert.ok(result.files);
    assert.equal(result.functions, undefined);
  });

  it('omits empty categories from result', () => {
    const entry = { content: 'No entities here at all' };
    const result = extractEntitiesFromEntry(entry);
    assert.deepEqual(result, {});
  });
});

// ---------------------------------------------------------------------------
// emptyEntityIndex
// ---------------------------------------------------------------------------

describe('emptyEntityIndex', () => {
  it('returns expected structure', () => {
    const idx = emptyEntityIndex();
    assert.deepEqual(Object.keys(idx).sort(), ['files', 'functions', 'errors', 'lastUpdated', 'packages'].sort());
    assert.deepEqual(idx.files, {});
    assert.deepEqual(idx.functions, {});
    assert.deepEqual(idx.errors, {});
    assert.deepEqual(idx.packages, {});
    assert.equal(idx.lastUpdated, null);
  });
});

// ---------------------------------------------------------------------------
// loadEntityIndex
// ---------------------------------------------------------------------------

describe('loadEntityIndex', () => {
  it('returns empty index when file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-entities-'));
    const idx = loadEntityIndex(dir);
    assert.deepEqual(idx.files, {});
    assert.equal(idx.lastUpdated, null);
  });

  it('loads existing index from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-entities-'));
    const index = { files: { 'src/a.ts': { mentions: 3 } }, functions: {}, errors: {}, packages: {}, lastUpdated: '2026-01-01' };
    writeFileSync(join(dir, 'entities.json'), JSON.stringify(index));
    const loaded = loadEntityIndex(dir);
    assert.equal(loaded.files['src/a.ts'].mentions, 3);
  });

  it('returns empty index and calls logError on corrupt JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-entities-'));
    writeFileSync(join(dir, 'entities.json'), '{corrupt');
    let errorLogged = false;
    const idx = loadEntityIndex(dir, () => { errorLogged = true; });
    assert.ok(errorLogged);
    assert.deepEqual(idx.files, {});
  });
});

// ---------------------------------------------------------------------------
// pruneEntityIndex
// ---------------------------------------------------------------------------

describe('pruneEntityIndex', () => {
  it('removes entries older than maxAgeDays', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const recentDate = new Date().toISOString();
    const index = {
      files: {
        'old.ts': { mentions: 1, lastSeen: oldDate, contexts: [] },
        'recent.ts': { mentions: 1, lastSeen: recentDate, contexts: [] },
      },
      functions: {},
      errors: {},
      packages: {},
    };
    pruneEntityIndex(index, { maxAgeDays: 7 });
    assert.ok(!index.files['old.ts']);
    assert.ok(index.files['recent.ts']);
  });

  it('removes entries with no lastSeen', () => {
    const index = {
      files: { 'orphan.ts': { mentions: 1, lastSeen: null, contexts: [] } },
      functions: {},
      errors: {},
      packages: {},
    };
    pruneEntityIndex(index, { maxAgeDays: 7 });
    assert.ok(!index.files['orphan.ts']);
  });

  it('skips pruning if already pruned within 24h', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const index = {
      files: { 'old.ts': { mentions: 1, lastSeen: oldDate, contexts: [] } },
      functions: {},
      errors: {},
      packages: {},
      lastPruned: new Date().toISOString(), // pruned just now
    };
    pruneEntityIndex(index, { maxAgeDays: 7 });
    // old.ts should still be there because pruning was skipped
    assert.ok(index.files['old.ts']);
  });

  it('does nothing when maxAgeDays <= 0', () => {
    const index = {
      files: { 'a.ts': { mentions: 1, lastSeen: '2020-01-01', contexts: [] } },
      functions: {},
      errors: {},
      packages: {},
    };
    pruneEntityIndex(index, { maxAgeDays: 0 });
    assert.ok(index.files['a.ts']);
  });

  it('sets lastPruned after pruning', () => {
    const index = {
      files: {},
      functions: {},
      errors: {},
      packages: {},
    };
    pruneEntityIndex(index, { maxAgeDays: 7 });
    assert.ok(index.lastPruned);
  });
});

// ---------------------------------------------------------------------------
// truncateContext
// ---------------------------------------------------------------------------

describe('truncateContext', () => {
  it('returns text unchanged when under limit', () => {
    assert.equal(truncateContext('short text', 100), 'short text');
  });

  it('returns empty string for falsy input', () => {
    assert.equal(truncateContext(null, 100), '');
    assert.equal(truncateContext(undefined, 100), '');
    assert.equal(truncateContext('', 100), '');
  });

  it('collapses whitespace', () => {
    assert.equal(truncateContext('a  b\n\nc', 100), 'a b c');
  });

  it('truncates at sentence boundary when possible', () => {
    const text = 'First sentence. Second sentence. Third sentence that goes on and on.';
    const result = truncateContext(text, 40);
    assert.ok(result.endsWith('...'));
    assert.ok(result.length <= 40);
  });

  it('truncates at word boundary as fallback', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve thirteen';
    const result = truncateContext(text, 30);
    assert.ok(result.endsWith('...'));
    assert.ok(!result.endsWith(' ...'));
  });

  it('hard-cuts when no good break point exists', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const result = truncateContext(text, 10);
    assert.ok(result.length <= 10);
    assert.ok(result.endsWith('...'));
  });
});

// ---------------------------------------------------------------------------
// applyExtractedEntitiesToIndex
// ---------------------------------------------------------------------------

describe('applyExtractedEntitiesToIndex', () => {
  it('adds new entities to index', () => {
    const index = emptyEntityIndex();
    const entities = { files: ['src/auth.ts'], functions: ['parseToken'] };
    const entry = { ts: '2026-01-01T00:00:00Z', type: 'response', content: 'test' };
    const count = applyExtractedEntitiesToIndex(index, entities, entry);
    assert.equal(count, 2);
    assert.equal(index.files['src/auth.ts'].mentions, 1);
    assert.equal(index.functions['parseToken'].mentions, 1);
  });

  it('increments mentions on repeated entities', () => {
    const index = emptyEntityIndex();
    const entities = { files: ['src/auth.ts'] };
    const entry = { ts: '2026-01-01T00:00:00Z', type: 'response', content: 'test' };
    applyExtractedEntitiesToIndex(index, entities, entry);
    applyExtractedEntitiesToIndex(index, entities, entry);
    assert.equal(index.files['src/auth.ts'].mentions, 2);
  });

  it('respects maxContextsPerEntity', () => {
    const index = emptyEntityIndex();
    const entities = { files: ['src/auth.ts'] };
    for (let i = 0; i < 10; i++) {
      const entry = { ts: new Date().toISOString(), type: 'response', content: `update ${i}` };
      applyExtractedEntitiesToIndex(index, entities, entry, { maxContextsPerEntity: 3 });
    }
    assert.equal(index.files['src/auth.ts'].contexts.length, 3);
  });

  it('keeps most recent contexts when capping', () => {
    const index = emptyEntityIndex();
    const entities = { files: ['a.ts'] };
    for (let i = 0; i < 5; i++) {
      applyExtractedEntitiesToIndex(index, entities,
        { ts: new Date().toISOString(), type: 'response', content: `msg-${i}` },
        { maxContextsPerEntity: 2 }
      );
    }
    const summaries = index.files['a.ts'].contexts.map(c => c.summary);
    assert.ok(summaries.some(s => s.includes('msg-3') || s.includes('msg-4')));
    assert.ok(!summaries.some(s => s.includes('msg-0')));
  });

  it('creates category in index if missing', () => {
    const index = { lastUpdated: null };
    const entities = { files: ['a.ts'] };
    const entry = { ts: new Date().toISOString(), type: 'response', content: 'test' };
    applyExtractedEntitiesToIndex(index, entities, entry);
    assert.ok(index.files['a.ts']);
  });
});

// ---------------------------------------------------------------------------
// writeEntityIndex
// ---------------------------------------------------------------------------

describe('writeEntityIndex', () => {
  it('writes JSON to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-entities-'));
    const index = emptyEntityIndex();
    index.files['a.ts'] = { mentions: 1 };
    const ok = writeEntityIndex(dir, index);
    assert.ok(ok);
    const loaded = JSON.parse(readFileSync(join(dir, 'entities.json'), 'utf-8'));
    assert.equal(loaded.files['a.ts'].mentions, 1);
  });

  it('calls logError and returns false on write failure', () => {
    let errorLogged = false;
    const ok = writeEntityIndex('/nonexistent/path', emptyEntityIndex(), () => { errorLogged = true; });
    assert.ok(!ok);
    assert.ok(errorLogged);
  });
});

// ---------------------------------------------------------------------------
// updateEntityIndexBatch
// ---------------------------------------------------------------------------

describe('updateEntityIndexBatch', () => {
  it('processes multiple entries and writes index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-entities-'));
    const entries = [
      { ts: new Date().toISOString(), type: 'response', content: 'Updated src/auth.ts' },
      { ts: new Date().toISOString(), type: 'response', content: 'Fixed `parseToken()` in src/auth.ts' },
    ];
    const result = updateEntityIndexBatch(entries, dir);
    assert.ok(result.processedEntries >= 1);
    assert.ok(result.entitiesExtracted >= 1);
    assert.equal(result.reads, 1);
    assert.equal(result.writes, 1);
    assert.ok(existsSync(join(dir, 'entities.json')));
  });

  it('returns zeros when disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-entities-'));
    const result = updateEntityIndexBatch(
      [{ ts: new Date().toISOString(), content: 'src/a.ts' }],
      dir,
      { entityExtraction: { enabled: false } }
    );
    assert.equal(result.processedEntries, 0);
    assert.equal(result.writes, 0);
  });

  it('returns zeros for empty entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-entities-'));
    const result = updateEntityIndexBatch([], dir);
    assert.equal(result.processedEntries, 0);
  });

  it('creates project dir if missing', () => {
    const base = mkdtempSync(join(tmpdir(), 'mneme-entities-'));
    const dir = join(base, 'sub', 'project');
    updateEntityIndexBatch(
      [{ ts: new Date().toISOString(), type: 'response', content: 'Updated src/auth.ts' }],
      dir
    );
    assert.ok(existsSync(dir));
  });

  it('skips write when no entities extracted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-entities-'));
    const result = updateEntityIndexBatch(
      [{ ts: new Date().toISOString(), type: 'response', content: 'no entities here whatsoever' }],
      dir
    );
    assert.equal(result.processedEntries, 0);
    assert.equal(result.writes, 0);
    assert.equal(result.reads, 1);
  });

  it('uses withFileLockFn when provided', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-entities-'));
    let lockUsed = false;
    const result = updateEntityIndexBatch(
      [{ ts: new Date().toISOString(), type: 'response', content: 'Updated src/auth.ts' }],
      dir,
      {},
      { withFileLockFn: (_lockPath, fn) => { lockUsed = true; return fn(); } }
    );
    assert.ok(lockUsed);
    assert.ok(result.processedEntries >= 1);
  });

  it('returns zeros when lock is not acquired', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-entities-'));
    const result = updateEntityIndexBatch(
      [{ ts: new Date().toISOString(), type: 'response', content: 'Updated src/auth.ts' }],
      dir,
      {},
      { withFileLockFn: () => undefined } // simulate lock failure
    );
    assert.equal(result.processedEntries, 0);
    assert.equal(result.writes, 0);
  });
});

// ---------------------------------------------------------------------------
// updateEntityIndex (single entry wrapper)
// ---------------------------------------------------------------------------

describe('updateEntityIndex', () => {
  it('delegates to batch with single entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-entities-'));
    updateEntityIndex(
      { ts: new Date().toISOString(), type: 'response', content: 'Updated src/auth.ts' },
      dir
    );
    assert.ok(existsSync(join(dir, 'entities.json')));
  });
});

// ---------------------------------------------------------------------------
// calculateRecencyScore
// ---------------------------------------------------------------------------

describe('calculateRecencyScore', () => {
  it('returns ~1.0 for very recent timestamps', () => {
    const score = calculateRecencyScore(new Date().toISOString());
    assert.ok(score > 0.99);
  });

  it('returns ~0.5 at half-life', () => {
    const halfLifeAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const score = calculateRecencyScore(halfLifeAgo, 24);
    assert.ok(score > 0.45 && score < 0.55, `Expected ~0.5, got ${score}`);
  });

  it('returns ~0.25 at double half-life', () => {
    const twoHalfLives = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const score = calculateRecencyScore(twoHalfLives, 24);
    assert.ok(score > 0.20 && score < 0.30, `Expected ~0.25, got ${score}`);
  });

  it('approaches 0 for very old timestamps', () => {
    const score = calculateRecencyScore('2020-01-01T00:00:00Z');
    assert.ok(score < 0.001);
  });
});

// ---------------------------------------------------------------------------
// calculateEntityRelevanceScore
// ---------------------------------------------------------------------------

describe('calculateEntityRelevanceScore', () => {
  it('returns 0.5 for empty entity index', () => {
    const entry = { content: 'Updated src/auth.ts' };
    assert.equal(calculateEntityRelevanceScore(entry, {}), 0.5);
    assert.equal(calculateEntityRelevanceScore(entry, null), 0.5);
  });

  it('returns 0.5 when no entities extracted from entry', () => {
    const entry = { content: 'nothing extractable here' };
    const index = { files: { 'src/auth.ts': { mentions: 5, lastSeen: new Date().toISOString() } } };
    assert.equal(calculateEntityRelevanceScore(entry, index), 0.5);
  });

  it('scores higher for recently-seen high-frequency entities', () => {
    const entry = { content: 'Updated src/auth.ts' };
    const recentIndex = {
      files: { 'src/auth.ts': { mentions: 10, lastSeen: new Date().toISOString(), contexts: [] } },
      functions: {},
      errors: {},
      packages: {},
    };
    const score = calculateEntityRelevanceScore(entry, recentIndex);
    assert.ok(score > 0.7, `Expected > 0.7, got ${score}`);
  });

  it('scores lower for old low-frequency entities', () => {
    const entry = { content: 'Updated src/auth.ts' };
    const oldIndex = {
      files: { 'src/auth.ts': { mentions: 1, lastSeen: '2020-01-01T00:00:00Z', contexts: [] } },
      functions: {},
      errors: {},
      packages: {},
    };
    const score = calculateEntityRelevanceScore(entry, oldIndex);
    assert.ok(score < 0.3, `Expected < 0.3, got ${score}`);
  });

  it('returns 0.5 when extracted entities are not in index', () => {
    const entry = { content: 'Updated src/auth.ts' };
    const index = {
      files: { 'other/file.ts': { mentions: 5, lastSeen: new Date().toISOString() } },
      functions: {},
      errors: {},
      packages: {},
    };
    const score = calculateEntityRelevanceScore(entry, index);
    assert.equal(score, 0.5);
  });
});
