import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTranscript,
  mineFiles,
  mineToolCalls,
  mineThinking,
  mineErrors,
  mineDecisions,
  mineTodos,
  mineInstructions,
  mineAll,
} from './mine.mjs';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function assistantMsg(content) {
  return { type: 'assistant', message: { content } };
}

function userMsg(content) {
  return { type: 'user', message: { content } };
}

function toolUse(name, input, id = 'tu_' + Math.random().toString(36).slice(2, 8)) {
  return { type: 'tool_use', name, input, id };
}

function toolResult(toolUseId, content, isError = false) {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError };
}

function thinkingBlock(text) {
  return { type: 'thinking', thinking: text };
}

function textBlock(text) {
  return { type: 'text', text };
}

// ---------------------------------------------------------------------------
// mineFiles
// ---------------------------------------------------------------------------

describe('mineFiles', () => {
  it('extracts Read/Write/Edit file paths', () => {
    const messages = [
      assistantMsg([toolUse('Read', { file_path: '/home/user/src/app.mjs' }, 'r1')]),
      assistantMsg([toolUse('Write', { file_path: '/home/user/src/new.mjs' }, 'w1')]),
      assistantMsg([toolUse('Edit', { file_path: '/home/user/src/app.mjs' }, 'e1')]),
    ];
    const files = mineFiles(messages);
    assert.ok(files.length >= 2);
    const paths = files.map(f => f.path);
    assert.ok(paths.some(p => p.includes('app.mjs')));
    assert.ok(paths.some(p => p.includes('new.mjs')));
  });

  it('tracks action types per file', () => {
    const messages = [
      assistantMsg([toolUse('Read', { file_path: '/src/foo.mjs' })]),
      assistantMsg([toolUse('Edit', { file_path: '/src/foo.mjs' })]),
    ];
    const files = mineFiles(messages);
    const foo = files.find(f => f.path.includes('foo.mjs'));
    assert.ok(foo);
    assert.ok(foo.actions.includes('read'));
    assert.ok(foo.actions.includes('edit'));
    assert.equal(foo.count, 2);
  });

  it('sorts by count descending', () => {
    const messages = [
      assistantMsg([toolUse('Read', { file_path: '/a.mjs' })]),
      assistantMsg([toolUse('Read', { file_path: '/b.mjs' })]),
      assistantMsg([toolUse('Read', { file_path: '/b.mjs' })]),
      assistantMsg([toolUse('Read', { file_path: '/b.mjs' })]),
    ];
    const files = mineFiles(messages);
    assert.equal(files[0].path, '/b.mjs');
    assert.equal(files[0].count, 3);
  });

  it('ignores non-assistant messages', () => {
    const messages = [
      userMsg([toolUse('Read', { file_path: '/x.mjs' })]),
    ];
    assert.deepEqual(mineFiles(messages), []);
  });

  it('returns empty for no messages', () => {
    assert.deepEqual(mineFiles([]), []);
  });
});

// ---------------------------------------------------------------------------
// mineToolCalls
// ---------------------------------------------------------------------------

describe('mineToolCalls', () => {
  it('counts tool calls and tracks sequence', () => {
    const messages = [
      assistantMsg([toolUse('Read', {}), toolUse('Bash', {})]),
      assistantMsg([toolUse('Edit', {}), toolUse('Bash', {})]),
    ];
    const result = mineToolCalls(messages);
    assert.equal(result.total, 4);
    assert.deepEqual(result.counts[0], ['Bash', 2]);
    assert.deepEqual(result.sequence, ['Read', 'Bash', 'Edit', 'Bash']);
  });

  it('returns empty for no tool calls', () => {
    const result = mineToolCalls([assistantMsg([textBlock('hello')])]);
    assert.equal(result.total, 0);
    assert.deepEqual(result.counts, []);
  });
});

// ---------------------------------------------------------------------------
// mineThinking
// ---------------------------------------------------------------------------

describe('mineThinking', () => {
  it('extracts thinking block summaries', () => {
    const longText = 'This is a detailed reasoning about the architecture choices we need to make for the new module.';
    const messages = [
      assistantMsg([thinkingBlock(longText)]),
    ];
    const blocks = mineThinking(messages);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].summary.startsWith('This is a detailed'));
    assert.equal(blocks[0].length, longText.length);
  });

  it('skips short thinking blocks', () => {
    const messages = [
      assistantMsg([thinkingBlock('ok')]),
    ];
    assert.deepEqual(mineThinking(messages), []);
  });

  it('truncates long first lines to 150 chars', () => {
    const longLine = 'x'.repeat(200);
    const messages = [assistantMsg([thinkingBlock(longLine)])];
    const blocks = mineThinking(messages);
    assert.equal(blocks[0].summary.length, 150);
  });
});

// ---------------------------------------------------------------------------
// mineErrors
// ---------------------------------------------------------------------------

describe('mineErrors', () => {
  it('captures is_error tool results', () => {
    const messages = [
      assistantMsg([toolUse('Bash', { command: 'false' }, 'b1')]),
      userMsg([toolResult('b1', 'command not found: something', true)]),
    ];
    const errors = mineErrors(messages);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].text.includes('command not found'));
    assert.equal(errors[0].tool, 'Bash');
  });

  it('captures exit code errors from non-error results', () => {
    const messages = [
      assistantMsg([toolUse('Bash', {}, 'b2')]),
      userMsg([toolResult('b2', 'Exit code 1\nsome output', false)]),
    ];
    const errors = mineErrors(messages);
    assert.equal(errors.length, 1);
  });

  it('captures ENOENT errors', () => {
    const messages = [
      assistantMsg([toolUse('Read', {}, 'r1')]),
      userMsg([toolResult('r1', 'ENOENT: no such file /foo.mjs', false)]),
    ];
    const errors = mineErrors(messages);
    assert.equal(errors.length, 1);
  });

  it('deduplicates errors by tool + first line', () => {
    const messages = [
      assistantMsg([toolUse('Bash', {}, 'b1')]),
      userMsg([toolResult('b1', 'Exit code 1\nfailed test a', false)]),
      assistantMsg([toolUse('Bash', {}, 'b2')]),
      userMsg([toolResult('b2', 'Exit code 1\nfailed test b', false)]),
    ];
    const errors = mineErrors(messages);
    assert.equal(errors.length, 1);
  });

  it('keeps errors from different tools separate', () => {
    const messages = [
      assistantMsg([toolUse('Bash', {}, 'b1'), toolUse('Read', {}, 'r1')]),
      userMsg([
        toolResult('b1', 'Exit code 1\nfail', false),
        toolResult('r1', 'Error: file not found', false),
      ]),
    ];
    const errors = mineErrors(messages);
    assert.equal(errors.length, 2);
  });

  it('skips normal successful results', () => {
    const messages = [
      assistantMsg([toolUse('Bash', {}, 'b1')]),
      userMsg([toolResult('b1', 'total 48\ndrwxr-xr-x 5 user user 4096', false)]),
    ];
    assert.deepEqual(mineErrors(messages), []);
  });
});

// ---------------------------------------------------------------------------
// mineDecisions
// ---------------------------------------------------------------------------

describe('mineDecisions', () => {
  it('captures decision patterns', () => {
    const messages = [
      assistantMsg([textBlock("I've decided to use a streaming parser for better performance.")]),
    ];
    const decisions = mineDecisions(messages);
    assert.ok(decisions.length >= 1);
    assert.ok(decisions[0].includes('streaming parser'));
  });

  it('captures "going with" pattern', () => {
    const messages = [
      assistantMsg([textBlock("Going with the hybrid approach for session mining.")]),
    ];
    assert.ok(mineDecisions(messages).length >= 1);
  });

  it('deduplicates identical decisions', () => {
    const messages = [
      assistantMsg([textBlock("I decided to use ESM modules for this project.")]),
      assistantMsg([textBlock("I decided to use ESM modules for this project.")]),
    ];
    const decisions = mineDecisions(messages);
    const unique = [...new Set(decisions)];
    assert.equal(decisions.length, unique.length);
  });

  it('ignores user messages', () => {
    const messages = [
      userMsg([textBlock("I decided to use Python instead.")]),
    ];
    assert.deepEqual(mineDecisions(messages), []);
  });
});

// ---------------------------------------------------------------------------
// mineTodos
// ---------------------------------------------------------------------------

describe('mineTodos', () => {
  it('captures TODO patterns', () => {
    const messages = [
      assistantMsg([textBlock("TODO: add error handling for edge cases")]),
    ];
    assert.ok(mineTodos(messages).length >= 1);
  });

  it('captures "need to" patterns', () => {
    const messages = [
      assistantMsg([textBlock("We need to add tests for the new mining module.")]),
    ];
    const todos = mineTodos(messages);
    assert.ok(todos.length >= 1);
    assert.ok(todos[0].includes('add tests'));
  });

  it('ignores user messages', () => {
    const messages = [
      userMsg([textBlock("TODO: something from user")]),
    ];
    assert.deepEqual(mineTodos(messages), []);
  });
});

// ---------------------------------------------------------------------------
// mineInstructions
// ---------------------------------------------------------------------------

describe('mineInstructions', () => {
  it('captures "don\'t" patterns from user', () => {
    const messages = [
      userMsg([textBlock("don't use mocks in these tests")]),
    ];
    assert.ok(mineInstructions(messages).length >= 1);
  });

  it('captures "always" patterns', () => {
    const messages = [
      userMsg([textBlock("always run tests before committing")]),
    ];
    assert.ok(mineInstructions(messages).length >= 1);
  });

  it('skips long messages (>500 chars)', () => {
    const messages = [
      userMsg([textBlock("don't " + 'x'.repeat(500))]),
    ];
    assert.deepEqual(mineInstructions(messages), []);
  });

  it('skips system-reminder content', () => {
    const messages = [
      userMsg([textBlock("<system-reminder>don't do something</system-reminder>")]),
    ];
    assert.deepEqual(mineInstructions(messages), []);
  });

  it('skips skill load messages', () => {
    const messages = [
      userMsg([textBlock("Base directory for this skill: /foo\ndon't forget this")]),
    ];
    assert.deepEqual(mineInstructions(messages), []);
  });

  it('ignores assistant messages', () => {
    const messages = [
      assistantMsg([textBlock("don't forget to test this")]),
    ];
    assert.deepEqual(mineInstructions(messages), []);
  });
});

// ---------------------------------------------------------------------------
// mineAll
// ---------------------------------------------------------------------------

describe('mineAll', () => {
  it('returns all categories', () => {
    const messages = [
      assistantMsg([
        thinkingBlock('Analyzing the problem space and considering multiple approaches for the implementation.'),
        toolUse('Read', { file_path: '/src/app.mjs' }, 'r1'),
        textBlock("I've decided to use a modular approach."),
      ]),
      userMsg([toolResult('r1', 'file contents here', false)]),
      userMsg([textBlock("don't add unnecessary abstractions")]),
    ];
    const result = mineAll(messages);
    assert.ok('files' in result);
    assert.ok('decisions' in result);
    assert.ok('errors' in result);
    assert.ok('todos' in result);
    assert.ok('thinking' in result);
    assert.ok('tools' in result);
    assert.ok('instructions' in result);
  });

  it('extracts from mixed messages', () => {
    const messages = [
      assistantMsg([
        toolUse('Bash', { command: 'npm test' }, 'b1'),
        textBlock("Going with the streaming approach."),
      ]),
      userMsg([toolResult('b1', 'Exit code 1\ntest failed', false)]),
      assistantMsg([textBlock("We need to fix the failing test.")]),
    ];
    const result = mineAll(messages);
    assert.ok(result.tools.total >= 1);
    assert.ok(result.decisions.length >= 1);
    assert.ok(result.errors.length >= 1);
    assert.ok(result.todos.length >= 1);
  });
});
