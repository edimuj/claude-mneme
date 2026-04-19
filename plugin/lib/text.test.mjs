import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stripMarkdown, splitSentences, extractiveSummarize } from './text.mjs';

describe('stripMarkdown', () => {
  it('returns null/undefined unchanged', () => {
    assert.equal(stripMarkdown(null), null);
    assert.equal(stripMarkdown(undefined), undefined);
    assert.equal(stripMarkdown(''), '');
  });

  it('strips code fences', () => {
    const input = '```js\nconst x = 1;\n```';
    assert.equal(stripMarkdown(input), 'const x = 1;');
  });

  it('strips HTML tags', () => {
    assert.equal(stripMarkdown('Hello <b>world</b>'), 'Hello world');
  });

  it('removes images but keeps link text', () => {
    assert.equal(stripMarkdown('![alt](url)'), '');
    assert.equal(stripMarkdown('[click here](url)'), 'click here');
  });

  it('strips headers', () => {
    assert.equal(stripMarkdown('## Title'), 'Title');
    assert.equal(stripMarkdown('# H1\n## H2'), 'H1\nH2');
  });

  it('strips bold and italic', () => {
    assert.equal(stripMarkdown('**bold** and *italic*'), 'bold and italic');
  });

  it('strips strikethrough', () => {
    assert.equal(stripMarkdown('~~removed~~'), 'removed');
  });

  it('strips inline code backticks', () => {
    assert.equal(stripMarkdown('use `foo()` here'), 'use foo() here');
  });

  it('strips blockquotes', () => {
    assert.equal(stripMarkdown('> quoted text'), 'quoted text');
  });

  it('strips bullet markers', () => {
    assert.equal(stripMarkdown('- item one\n- item two'), 'item one\nitem two');
  });

  it('strips numbered list markers', () => {
    assert.equal(stripMarkdown('1. first\n2. second'), 'first\nsecond');
  });

  it('strips checkboxes', () => {
    assert.equal(stripMarkdown('- [x] done\n- [ ] pending'), 'done\npending');
  });

  it('strips horizontal rules', () => {
    assert.equal(stripMarkdown('above\n---\nbelow'), 'above\n\nbelow');
  });

  it('collapses excessive blank lines', () => {
    const result = stripMarkdown('a\n\n\n\n\nb');
    assert.ok(!result.includes('\n\n\n'));
  });
});

describe('splitSentences', () => {
  it('splits on sentence-ending punctuation', () => {
    const result = splitSentences('First sentence. Second sentence.');
    assert.equal(result.length, 2);
    assert.equal(result[0], 'First sentence.');
  });

  it('splits bullet lists into items', () => {
    const result = splitSentences('- alpha\n- beta\n- gamma');
    assert.equal(result.length, 3);
    assert.equal(result[0], 'alpha');
  });

  it('handles single sentence', () => {
    const result = splitSentences('just one thing');
    assert.equal(result.length, 1);
  });

  it('handles empty input', () => {
    const result = splitSentences('');
    assert.equal(result.length, 0);
  });

  it('handles whitespace-only input', () => {
    const result = splitSentences('   \n  \n  ');
    assert.equal(result.length, 0);
  });

  it('separates paragraphs', () => {
    const result = splitSentences('First paragraph.\n\nSecond paragraph.');
    assert.equal(result.length, 2);
  });

  it('normalizes whitespace within paragraphs', () => {
    const result = splitSentences('lots   of    spaces');
    assert.equal(result[0], 'lots of spaces');
  });
});

describe('extractiveSummarize', () => {
  const config = {
    maxSummarySentences: 2,
    actionWords: ['fix', 'add', 'remove', 'change'],
    reasoningWords: ['because', 'since', 'therefore']
  };

  it('returns short text unchanged', () => {
    const result = extractiveSummarize('Short text.', config);
    assert.equal(result, 'Short text.');
  });

  it('returns all sentences when under max', () => {
    const result = extractiveSummarize('First. Second.', { ...config, maxSummarySentences: 5 });
    assert.ok(result.includes('First'));
    assert.ok(result.includes('Second'));
  });

  it('truncates to maxSummarySentences', () => {
    const text = 'First sentence. Second sentence. Third sentence. Fourth sentence.';
    const result = extractiveSummarize(text, config);
    const sentences = result.split(/(?<=[.!?])\s+/);
    assert.ok(sentences.length <= 2);
  });

  it('always keeps the first sentence', () => {
    const text = 'Opening statement. Middle fluff. Important: fix the bug. More fluff.';
    const result = extractiveSummarize(text, config);
    assert.ok(result.startsWith('Opening statement'));
  });

  it('prefers sentences with action words', () => {
    const text = 'Background info. We need to fix the login bug. Also some other detail. Random text here.';
    const result = extractiveSummarize(text, config);
    assert.ok(result.includes('fix'));
  });

  it('strips lead-in sentences', () => {
    const text = "Here's what changed:\nFixed the login bug. Updated the tests. Added error handling.";
    const result = extractiveSummarize(text, { ...config, maxSummarySentences: 3 });
    assert.ok(!result.includes("Here's what changed"));
  });

  it('handles empty text', () => {
    const result = extractiveSummarize('', config);
    assert.equal(result, '');
  });

  it('boosts sentences with file references', () => {
    const text = 'General comment. Changed src/utils.mjs to fix the issue. Another note.';
    const result = extractiveSummarize(text, config);
    assert.ok(result.includes('utils.mjs'));
  });
});
