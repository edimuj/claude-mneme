import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  tokenize,
  scoreTextRelevance,
  extractSearchTerms,
  gatherContextSignals,
  retrieveRelevantMemory,
} from './memory-retriever.mjs';

// ============================================================================
// tokenize
// ============================================================================
describe('tokenize', () => {
  it('splits camelCase', () => {
    assert.deepStrictEqual(tokenize('readCachedData'), ['read', 'cached', 'data']);
  });

  it('splits snake_case', () => {
    assert.deepStrictEqual(tokenize('memory_retriever'), ['memory', 'retriever']);
  });

  it('splits kebab-case', () => {
    assert.deepStrictEqual(tokenize('session-start'), ['session', 'start']);
  });

  it('extracts tokens from file paths', () => {
    const tokens = tokenize('plugin/lib/entities.mjs');
    assert.ok(tokens.includes('plugin'));
    assert.ok(tokens.includes('entities'));
    assert.ok(!tokens.includes('mjs')); // extension stripped
  });

  it('filters stopwords and short tokens', () => {
    const tokens = tokenize('the quick and brown fox');
    assert.ok(!tokens.includes('the'));
    assert.ok(!tokens.includes('and'));
    assert.ok(tokens.includes('quick'));
    assert.ok(tokens.includes('brown'));
  });

  it('lowercases all tokens', () => {
    assert.deepStrictEqual(tokenize('AuthRedesign'), ['auth', 'redesign']);
  });

  it('returns empty for null/undefined/empty', () => {
    assert.deepStrictEqual(tokenize(null), []);
    assert.deepStrictEqual(tokenize(''), []);
    assert.deepStrictEqual(tokenize(undefined), []);
  });
});

// ============================================================================
// scoreTextRelevance
// ============================================================================
describe('scoreTextRelevance', () => {
  it('returns 0 for no text', () => {
    const terms = { tokenWeights: new Map([['auth', 1.0]]), rawFilePaths: [] };
    assert.equal(scoreTextRelevance('', terms), 0);
    assert.equal(scoreTextRelevance(null, terms), 0);
  });

  it('returns 0 for no search terms', () => {
    const terms = { tokenWeights: new Map(), rawFilePaths: [] };
    assert.equal(scoreTextRelevance('some text here', terms), 0);
  });

  it('scores proportional to weighted token hits', () => {
    const terms = {
      tokenWeights: new Map([['auth', 1.0], ['login', 0.8], ['dashboard', 0.6]]),
      rawFilePaths: [],
    };
    const scoreAll = scoreTextRelevance('auth login dashboard', terms);
    const scoreOne = scoreTextRelevance('auth only here', terms);
    assert.ok(scoreAll > scoreOne, `all=${scoreAll} should > one=${scoreOne}`);
    assert.ok(scoreAll > 0.8);
    assert.ok(scoreOne > 0 && scoreOne < 0.6);
  });

  it('boosts score for exact file path match', () => {
    const terms = {
      tokenWeights: new Map([['auth', 0.8], ['login', 0.6], ['session', 0.4]]),
      rawFilePaths: ['src/auth.ts'],
    };
    const withPath = scoreTextRelevance('Modified src/auth.ts for auth', terms);
    const withoutPath = scoreTextRelevance('Auth was changed somewhere', terms);
    assert.ok(withPath > withoutPath, `withPath=${withPath} should > withoutPath=${withoutPath}`);
  });

  it('score is capped at 1.0', () => {
    const terms = {
      tokenWeights: new Map([['auth', 1.0]]),
      rawFilePaths: ['auth.ts'],
    };
    const score = scoreTextRelevance('auth auth.ts auth', terms);
    assert.ok(score <= 1.0);
  });
});

// ============================================================================
// extractSearchTerms
// ============================================================================
describe('extractSearchTerms', () => {
  it('extracts file tokens from modified files', () => {
    const signals = {
      modifiedFiles: ['plugin/lib/entities.mjs', 'plugin/scripts/session-start.mjs'],
      stagedFiles: [],
      branchName: 'main',
      handoff: null,
      hotEntityNames: [],
    };
    const terms = extractSearchTerms(signals);
    assert.ok(terms.tokenWeights.has('entities'));
    assert.ok(terms.tokenWeights.has('session'));
    assert.ok(terms.tokenWeights.has('start'));
    assert.deepStrictEqual(terms.rawFilePaths, signals.modifiedFiles);
  });

  it('extracts intent tokens from feature branch', () => {
    const signals = {
      modifiedFiles: [],
      stagedFiles: [],
      branchName: 'feature/auth-redesign',
      handoff: null,
      hotEntityNames: [],
    };
    const terms = extractSearchTerms(signals);
    assert.ok(terms.tokenWeights.has('auth'));
    assert.ok(terms.tokenWeights.has('redesign'));
    assert.ok(terms.tokenWeights.get('auth') >= 0.9);
  });

  it('ignores uninformative branch names', () => {
    const signals = {
      modifiedFiles: [],
      stagedFiles: [],
      branchName: 'main',
      handoff: null,
      hotEntityNames: [],
    };
    const terms = extractSearchTerms(signals);
    assert.ok(!terms.tokenWeights.has('main'));
  });

  it('extracts concept tokens from handoff', () => {
    const signals = {
      modifiedFiles: [],
      stagedFiles: [],
      branchName: 'main',
      handoff: { workingOn: 'Implementing relevance retrieval', keyInsight: 'Memory is the bottleneck' },
      hotEntityNames: [],
    };
    const terms = extractSearchTerms(signals);
    assert.ok(terms.tokenWeights.has('relevance'));
    assert.ok(terms.tokenWeights.has('retrieval'));
    assert.ok(terms.tokenWeights.has('memory'));
    assert.ok(terms.tokenWeights.has('bottleneck'));
  });

  it('calculates signal strength', () => {
    const strong = extractSearchTerms({
      modifiedFiles: ['a.mjs'], stagedFiles: [],
      branchName: 'feature/auth', handoff: { workingOn: 'auth' }, hotEntityNames: ['auth.mjs'],
    });
    const weak = extractSearchTerms({
      modifiedFiles: [], stagedFiles: [],
      branchName: 'main', handoff: null, hotEntityNames: [],
    });
    assert.ok(strong.signalStrength > weak.signalStrength);
    assert.ok(weak.signalStrength < 0.2);
  });

  it('caps modified files at 20', () => {
    const signals = {
      modifiedFiles: Array.from({ length: 30 }, (_, i) => `file${i}.mjs`),
      stagedFiles: [], branchName: 'main', handoff: null, hotEntityNames: [],
    };
    const terms = extractSearchTerms(signals);
    assert.ok(terms.rawFilePaths.length <= 20);
  });
});

// ============================================================================
// gatherContextSignals
// ============================================================================
describe('gatherContextSignals', () => {
  it('gathers signals from a git repo with modified files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-test-'));
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, 'foo.mjs'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
    writeFileSync(join(dir, 'foo.mjs'), 'export const x = 2;\n'); // modify

    const signals = gatherContextSignals(dir, {}, {});
    assert.ok(signals.modifiedFiles.includes('foo.mjs'));
    assert.ok(typeof signals.branchName === 'string');
  });

  it('handles non-git directory gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-test-'));
    const signals = gatherContextSignals(dir, {}, {});
    assert.deepStrictEqual(signals.modifiedFiles, []);
    assert.equal(signals.branchName, '');
  });

  it('reads handoff from paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-test-'));
    const handoffPath = join(dir, 'handoff.json');
    writeFileSync(handoffPath, JSON.stringify({
      ts: new Date().toISOString(),
      workingOn: 'Testing retrieval',
    }));
    const signals = gatherContextSignals(dir, {}, { handoff: handoffPath });
    assert.equal(signals.handoff.workingOn, 'Testing retrieval');
  });
});

// ============================================================================
// retrieveRelevantMemory
// ============================================================================
describe('retrieveRelevantMemory', () => {
  const makeTerms = (tokens, paths = []) => ({
    tokenWeights: new Map(tokens.map(([t, w]) => [t, w])),
    rawFilePaths: paths,
    signalStrength: 0.5,
  });

  it('scores keyDecisions by text relevance', () => {
    const terms = makeTerms([['auth', 1.0], ['login', 0.8]]);
    const cachedData = {
      summary: {
        projectContext: 'A web app',
        keyDecisions: [
          { decision: 'Use JWT for auth', reason: 'Stateless login', foundational: true },
          { decision: 'Use PostgreSQL', reason: 'Relational data', foundational: true },
          { decision: 'Add rate limiting', reason: 'Auth abuse prevention', foundational: false },
        ],
        currentState: [],
        recentWork: [],
      },
      logEntries: [],
      remembered: [],
      entities: {},
    };
    const result = retrieveRelevantMemory(terms, cachedData, {});
    assert.ok(result.decisions[0]._relevance > result.decisions[1]._relevance);
    assert.ok(result.decisions[0].decision.includes('JWT'));
  });

  it('scores log entries with recency + relevance blend', () => {
    const now = new Date();
    const terms = makeTerms([['auth', 1.0]]);
    const cachedData = {
      summary: { keyDecisions: [], currentState: [], recentWork: [] },
      logEntries: [
        { ts: new Date(now - 3600000).toISOString(), type: 'commit', content: 'fix auth token refresh' },
        { ts: new Date(now - 7200000).toISOString(), type: 'prompt', content: 'update the dashboard styles' },
        { ts: new Date(now - 1800000).toISOString(), type: 'response', content: 'deployed the new build' },
      ],
      remembered: [],
      entities: {},
    };
    const result = retrieveRelevantMemory(terms, cachedData, {});
    assert.ok(result.entries[0].content.includes('auth'));
  });

  it('returns null when signalStrength is too weak', () => {
    const terms = { tokenWeights: new Map(), rawFilePaths: [], signalStrength: 0.1 };
    const cachedData = {
      summary: { keyDecisions: [], currentState: [], recentWork: [] },
      logEntries: [],
      remembered: [],
      entities: {},
    };
    const result = retrieveRelevantMemory(terms, cachedData, {});
    assert.equal(result, null);
  });

  it('always includes foundational decisions', () => {
    const terms = makeTerms([['dashboard', 1.0]]);
    const cachedData = {
      summary: {
        keyDecisions: [
          { decision: 'Use JWT for auth', reason: 'Security', foundational: true },
          { decision: 'Dashboard uses React', reason: 'Speed', foundational: false },
        ],
        currentState: [],
        recentWork: [],
      },
      logEntries: [],
      remembered: [],
      entities: {},
    };
    const result = retrieveRelevantMemory(terms, cachedData, {});
    const decisions = result.decisions.map(d => d.decision);
    assert.ok(decisions.includes('Use JWT for auth'));
    assert.ok(decisions.includes('Dashboard uses React'));
  });

  it('guarantees at least one recent entry per section', () => {
    const terms = makeTerms([['zzz_nomatch', 1.0]]);
    const cachedData = {
      summary: {
        keyDecisions: [{ decision: 'Something unrelated', reason: 'reason', foundational: false }],
        currentState: [{ topic: 'Unrelated', status: 'done' }],
        recentWork: [{ date: '2026-02-24', summary: 'Nothing relevant' }],
      },
      logEntries: [{ ts: new Date().toISOString(), type: 'prompt', content: 'unrelated prompt' }],
      remembered: [],
      entities: {},
    };
    const result = retrieveRelevantMemory(terms, cachedData, {});
    assert.ok(result.decisions.length >= 1);
    assert.ok(result.state.length >= 1);
    assert.ok(result.work.length >= 1);
    assert.ok(result.entries.length >= 1);
  });
});
