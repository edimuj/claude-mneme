import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readTranscript,
  extractText,
  extractDecisions,
  extractFiles,
  extractErrors,
  extractTodos,
  saveSnapshot,
} from './pre-compact.mjs';

// ---------------------------------------------------------------------------
// Helper — build a minimal transcript entry
// ---------------------------------------------------------------------------

function assistantMsg(text) {
  return { type: 'assistant', message: { content: text } };
}

function userMsg(text) {
  return { type: 'user', message: { content: text } };
}

function arrayContentMsg(texts) {
  return {
    type: 'assistant',
    message: {
      content: texts.map(t => ({ type: 'text', text: t })),
    },
  };
}

// ---------------------------------------------------------------------------
// readTranscript
// ---------------------------------------------------------------------------

describe('readTranscript', () => {
  it('returns empty array for missing path', () => {
    assert.deepEqual(readTranscript(null), []);
    assert.deepEqual(readTranscript('/nonexistent/file.jsonl'), []);
  });

  it('returns empty array for empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-pc-'));
    const p = join(dir, 'transcript.jsonl');
    writeFileSync(p, '');
    assert.deepEqual(readTranscript(p), []);
  });

  it('parses valid JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-pc-'));
    const p = join(dir, 'transcript.jsonl');
    writeFileSync(p, '{"type":"user","message":{"content":"hello"}}\n{"type":"assistant","message":{"content":"hi"}}\n');
    const result = readTranscript(p);
    assert.equal(result.length, 2);
    assert.equal(result[0].type, 'user');
    assert.equal(result[1].type, 'assistant');
  });

  it('skips malformed lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-pc-'));
    const p = join(dir, 'transcript.jsonl');
    writeFileSync(p, '{"type":"user"}\n{corrupt\n{"type":"assistant"}\n');
    const result = readTranscript(p);
    assert.equal(result.length, 2);
  });
});

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe('extractText', () => {
  it('returns string content as-is', () => {
    assert.equal(extractText('hello world'), 'hello world');
  });

  it('extracts text from content blocks', () => {
    const content = [
      { type: 'text', text: 'First' },
      { type: 'tool_use', name: 'Bash' },
      { type: 'text', text: 'Second' },
    ];
    assert.equal(extractText(content), 'First\nSecond');
  });

  it('returns empty for non-string non-array', () => {
    assert.equal(extractText(42), '');
    assert.equal(extractText(null), '');
    assert.equal(extractText(undefined), '');
  });
});

// ---------------------------------------------------------------------------
// extractDecisions
// ---------------------------------------------------------------------------

describe('extractDecisions', () => {
  it('extracts "decided to" patterns', () => {
    const transcript = [
      assistantMsg('I decided to use TypeScript for the new module because it catches more bugs.'),
    ];
    const decisions = extractDecisions(transcript, 10);
    assert.ok(decisions.length > 0);
    assert.ok(decisions.some(d => d.toLowerCase().includes('typescript')));
  });

  it('extracts "going with" patterns', () => {
    const transcript = [
      assistantMsg('After considering the options, going with the singleton pattern for the service.'),
    ];
    const decisions = extractDecisions(transcript, 10);
    assert.ok(decisions.length > 0);
  });

  it('extracts "let\'s use" patterns', () => {
    const transcript = [
      assistantMsg("let's use Redis for caching since it's already in the stack"),
    ];
    const decisions = extractDecisions(transcript, 10);
    assert.ok(decisions.length > 0);
  });

  it('only extracts from assistant messages', () => {
    const transcript = [
      userMsg('I decided to rewrite everything in Rust'),
    ];
    const decisions = extractDecisions(transcript, 10);
    assert.equal(decisions.length, 0);
  });

  it('respects maxItems limit', () => {
    const transcript = [
      assistantMsg('decided to use A for this. decided to use B for that. decided to use C for the other.'),
    ];
    const decisions = extractDecisions(transcript, 1);
    assert.ok(decisions.length <= 1);
  });

  it('deduplicates decisions', () => {
    const transcript = [
      assistantMsg('decided to use TypeScript. Also decided to use TypeScript.'),
    ];
    const decisions = extractDecisions(transcript, 10);
    const tsDecisions = decisions.filter(d => d.toLowerCase().includes('typescript'));
    assert.ok(tsDecisions.length <= 1);
  });

  it('returns empty for no decisions', () => {
    const transcript = [
      assistantMsg('Everything is working fine, no changes needed.'),
    ];
    assert.deepEqual(extractDecisions(transcript, 10), []);
  });

  it('handles array content blocks', () => {
    const transcript = [
      arrayContentMsg(['After review, going with the worker thread approach for heavy computation.']),
    ];
    const decisions = extractDecisions(transcript, 10);
    assert.ok(decisions.length > 0);
  });
});

// ---------------------------------------------------------------------------
// extractFiles
// ---------------------------------------------------------------------------

describe('extractFiles', () => {
  it('extracts file paths with directories', () => {
    const transcript = [
      assistantMsg('Updated src/auth.ts and lib/utils.mjs to fix the issue'),
    ];
    const files = extractFiles(transcript, 20);
    assert.ok(files.includes('src/auth.ts'));
    assert.ok(files.includes('lib/utils.mjs'));
  });

  it('extracts backtick-quoted files', () => {
    const transcript = [
      userMsg('Check `config.json` for the settings'),
    ];
    const files = extractFiles(transcript, 20);
    assert.ok(files.some(f => f.includes('config.json')));
  });

  it('skips domain-like extensions', () => {
    const transcript = [
      assistantMsg('Visit example.com and api.io for docs'),
    ];
    const files = extractFiles(transcript, 20);
    assert.ok(!files.some(f => f.includes('example.com')));
    assert.ok(!files.some(f => f.includes('api.io')));
  });

  it('respects maxItems', () => {
    const transcript = [
      assistantMsg('Files: a.ts b.ts c.ts d.ts e.ts f.ts g.ts h.ts'),
    ];
    const files = extractFiles(transcript, 3);
    assert.ok(files.length <= 3);
  });

  it('returns empty for no files', () => {
    const transcript = [assistantMsg('No file references here')];
    assert.deepEqual(extractFiles(transcript, 10), []);
  });

  it('reads content from both user and assistant', () => {
    const transcript = [
      userMsg('Look at test/app.test.ts'),
      assistantMsg('Also check server/index.ts'),
    ];
    const files = extractFiles(transcript, 20);
    assert.ok(files.length >= 2);
  });
});

// ---------------------------------------------------------------------------
// extractErrors
// ---------------------------------------------------------------------------

describe('extractErrors', () => {
  it('extracts TypeError messages', () => {
    const transcript = [
      assistantMsg('TypeError: Cannot read properties of undefined (reading foo)'),
    ];
    const errors = extractErrors(transcript, 10);
    assert.ok(errors.length > 0);
    assert.ok(errors.some(e => e.includes('Cannot read properties')));
  });

  it('extracts "cannot" patterns', () => {
    const transcript = [
      assistantMsg('cannot find module express in the project'),
    ];
    const errors = extractErrors(transcript, 10);
    assert.ok(errors.length > 0);
  });

  it('extracts "failed:" patterns', () => {
    const transcript = [
      assistantMsg('failed: connection refused to database at port 5432'),
    ];
    const errors = extractErrors(transcript, 10);
    assert.ok(errors.length > 0);
  });

  it('deduplicates overlapping errors', () => {
    const transcript = [
      assistantMsg('error: connection refused. Also error: connection refused again'),
    ];
    const errors = extractErrors(transcript, 10);
    // Should not have both if one includes the other
    assert.ok(errors.length >= 1);
  });

  it('respects maxItems', () => {
    const transcript = [
      assistantMsg('error: first problem. error: second problem. error: third problem. error: fourth problem.'),
    ];
    const errors = extractErrors(transcript, 2);
    assert.ok(errors.length <= 2);
  });

  it('returns empty for no errors', () => {
    const transcript = [assistantMsg('All tests passed successfully!')];
    assert.deepEqual(extractErrors(transcript, 10), []);
  });
});

// ---------------------------------------------------------------------------
// extractTodos
// ---------------------------------------------------------------------------

describe('extractTodos', () => {
  it('extracts TODO: comments', () => {
    const transcript = [
      assistantMsg('TODO: add input validation for the API endpoint before we ship'),
    ];
    const todos = extractTodos(transcript, 10);
    assert.ok(todos.length > 0);
    assert.ok(todos.some(t => t.toLowerCase().includes('input validation')));
  });

  it('extracts "need to" action items', () => {
    const transcript = [
      assistantMsg('We need to add error handling for the network calls'),
    ];
    const todos = extractTodos(transcript, 10);
    assert.ok(todos.length > 0);
  });

  it('extracts "should fix" patterns', () => {
    const transcript = [
      assistantMsg('We should fix the race condition in the lock manager before release'),
    ];
    const todos = extractTodos(transcript, 10);
    assert.ok(todos.length > 0);
  });

  it('only extracts from assistant messages', () => {
    const transcript = [
      userMsg('TODO: remember to buy groceries'),
    ];
    const todos = extractTodos(transcript, 10);
    assert.equal(todos.length, 0);
  });

  it('extracts "next step:" patterns', () => {
    const transcript = [
      assistantMsg('next step: implement the retry logic with exponential backoff'),
    ];
    const todos = extractTodos(transcript, 10);
    assert.ok(todos.length > 0);
  });

  it('respects maxItems', () => {
    const transcript = [
      assistantMsg('need to add tests. need to fix lint. need to update docs. need to refactor auth.'),
    ];
    const todos = extractTodos(transcript, 2);
    assert.ok(todos.length <= 2);
  });

  it('returns empty for no todos', () => {
    const transcript = [assistantMsg('Everything is done and deployed.')];
    assert.deepEqual(extractTodos(transcript, 10), []);
  });
});

// ---------------------------------------------------------------------------
// saveSnapshot
// ---------------------------------------------------------------------------

describe('saveSnapshot', () => {
  it('creates snapshot file in snapshots directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-pc-'));
    const projectDir = join(dir, 'project');
    mkdirSync(projectDir, { recursive: true });

    const transcript = [
      { type: 'user', message: { content: 'hello' } },
      { type: 'assistant', message: { content: 'hi' } },
    ];

    const path = saveSnapshot(transcript, { project: projectDir }, 'auto');
    assert.ok(existsSync(path));
    assert.ok(path.includes('pre-compact-auto-'));
    assert.ok(path.endsWith('.jsonl'));

    // Verify content is valid JSONL
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]).type, 'user');
  });

  it('rotates old snapshots when maxCount exceeded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-pc-'));
    const projectDir = join(dir, 'project');
    mkdirSync(projectDir, { recursive: true });

    const transcript = [{ type: 'user', message: { content: 'test' } }];

    // Create more than maxCount snapshots
    for (let i = 0; i < 5; i++) {
      saveSnapshot(transcript, { project: projectDir }, 'auto', 3);
    }

    const snapshotDir = join(projectDir, 'snapshots');
    const files = readdirSync(snapshotDir).filter(f => f.startsWith('pre-compact-'));
    assert.ok(files.length <= 3, `Expected <= 3 snapshots, got ${files.length}`);
  });

  it('creates snapshots directory if missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-pc-'));
    const projectDir = join(dir, 'project');
    mkdirSync(projectDir, { recursive: true });

    const snapshotDir = join(projectDir, 'snapshots');
    assert.ok(!existsSync(snapshotDir));

    saveSnapshot([{ type: 'user' }], { project: projectDir }, 'manual');
    assert.ok(existsSync(snapshotDir));
  });
});
