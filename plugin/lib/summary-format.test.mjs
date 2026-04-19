import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_DECISION_LINE,
  formatEntry,
  formatEntriesForSummary,
  emptyStructuredSummary,
  formatDecisionLine,
  renderSummaryToMarkdown,
  renderSummaryFull
} from './summary-format.mjs';

describe('MAX_DECISION_LINE', () => {
  it('is a number', () => {
    assert.equal(typeof MAX_DECISION_LINE, 'number');
    assert.equal(MAX_DECISION_LINE, 160);
  });
});

describe('formatEntry', () => {
  it('formats prompt entry with timestamp', () => {
    const entry = { ts: '2025-01-15T10:30:00Z', type: 'prompt', content: 'fix the bug' };
    const result = formatEntry(entry);
    assert.ok(result.includes('User:'));
    assert.ok(result.includes('fix the bug'));
  });

  it('formats response entry', () => {
    const entry = { ts: '2025-01-15T10:30:00Z', type: 'response', content: 'Done.' };
    const result = formatEntry(entry);
    assert.ok(result.includes('Assistant:'));
  });

  it('formats commit entry', () => {
    const entry = { ts: '2025-01-15T10:30:00Z', type: 'commit', content: 'Git commit: fix login' };
    const result = formatEntry(entry);
    assert.ok(result.includes('Commit:'));
    assert.ok(result.includes('fix login'));
    assert.ok(!result.includes('Git commit:'));
  });

  it('formats agent entry', () => {
    const entry = { ts: '2025-01-15T10:30:00Z', type: 'agent', content: 'analyzed code', agent_type: 'review' };
    const result = formatEntry(entry);
    assert.ok(result.includes('Agent (review):'));
  });

  it('formats task entry with action/subject', () => {
    const entry = { ts: '2025-01-15T10:30:00Z', type: 'task', action: 'create', subject: 'login page' };
    const result = formatEntry(entry);
    assert.ok(result.includes('Task create:'));
    assert.ok(result.includes('login page'));
  });

  it('formats task entry with outcome', () => {
    const entry = { ts: '2025-01-15T10:30:00Z', type: 'task', action: 'fix', subject: 'bug', outcome: 'completed' };
    const result = formatEntry(entry);
    assert.ok(result.includes('[completed]'));
  });

  it('includes merged-from info', () => {
    const entry = { ts: '2025-01-15T10:30:00Z', type: 'prompt', content: 'hello', _mergedFrom: ['response', 'commit'] };
    const result = formatEntry(entry);
    assert.ok(result.includes('(also: response, commit)'));
  });

  it('handles unknown type', () => {
    const entry = { ts: '2025-01-15T10:30:00Z', type: 'custom', content: 'data' };
    const result = formatEntry(entry);
    assert.ok(result.includes('(custom)'));
    assert.ok(result.includes('data'));
  });
});

describe('formatEntriesForSummary', () => {
  it('returns empty string for no entries', () => {
    assert.equal(formatEntriesForSummary([]), '');
  });

  it('returns empty string for unparseable lines', () => {
    assert.equal(formatEntriesForSummary(['not json', '{bad']), '');
  });

  it('groups entries by day', () => {
    const lines = [
      JSON.stringify({ ts: '2025-01-15T10:00:00Z', type: 'commit', content: 'fix a' }),
      JSON.stringify({ ts: '2025-01-16T10:00:00Z', type: 'commit', content: 'fix b' })
    ];
    const result = formatEntriesForSummary(lines);
    assert.ok(result.includes('###'));
    const headers = result.match(/^###/gm);
    assert.equal(headers.length, 2);
  });

  it('groups temporally adjacent entries into work units', () => {
    const base = new Date('2025-01-15T10:00:00Z');
    const lines = [
      JSON.stringify({ ts: base.toISOString(), type: 'prompt', content: 'fix login' }),
      JSON.stringify({ ts: new Date(base.getTime() + 60000).toISOString(), type: 'commit', content: 'fix(login): handle null' }),
      JSON.stringify({ ts: new Date(base.getTime() + 120000).toISOString(), type: 'response', content: 'Fixed the issue' })
    ];
    const result = formatEntriesForSummary(lines);
    assert.ok(result.includes('→'), 'Grouped entries should use → separator');
  });
});

describe('emptyStructuredSummary', () => {
  it('returns expected structure', () => {
    const s = emptyStructuredSummary();
    assert.equal(s.projectContext, '');
    assert.deepEqual(s.keyDecisions, []);
    assert.deepEqual(s.currentState, []);
    assert.deepEqual(s.recentWork, []);
    assert.equal(s.lastUpdated, null);
  });

  it('returns a new object each call', () => {
    const a = emptyStructuredSummary();
    const b = emptyStructuredSummary();
    assert.notEqual(a, b);
    a.keyDecisions.push('x');
    assert.equal(b.keyDecisions.length, 0);
  });
});

describe('formatDecisionLine', () => {
  it('renders short decision + reason normally', () => {
    const result = formatDecisionLine({ decision: 'Use ESM', reason: 'Better tree shaking' });
    assert.equal(result, '- **Use ESM** — Better tree shaking');
  });

  it('renders decision without reason', () => {
    const result = formatDecisionLine({ decision: 'Use ESM' });
    assert.equal(result, '- **Use ESM**');
  });

  it('caps long reason at ~160 chars total', () => {
    const result = formatDecisionLine({
      decision: 'Short',
      reason: 'A'.repeat(200)
    });
    assert.ok(result.length <= MAX_DECISION_LINE + 5);
  });

  it('drops reason entirely if decision itself is near limit', () => {
    const result = formatDecisionLine({
      decision: 'D'.repeat(150),
      reason: 'should be dropped'
    });
    assert.ok(!result.includes('should be dropped'));
  });

  it('truncates at sentence boundary when possible', () => {
    const result = formatDecisionLine({
      decision: 'Choice',
      reason: 'First reason applies. Second reason is less important. Third reason fills space and should be cut off eventually.'
    });
    if (result.length < MAX_DECISION_LINE + 5) {
      assert.ok(result.endsWith('.') || result.endsWith('...') || result.endsWith('**'));
    }
  });
});

describe('renderSummaryToMarkdown', () => {
  it('renders header', () => {
    const s = emptyStructuredSummary();
    const result = renderSummaryToMarkdown(s, 'test-project');
    assert.ok(result.full.includes('# Claude Memory Summary'));
  });

  it('renders lastUpdated timestamp', () => {
    const s = { ...emptyStructuredSummary(), lastUpdated: '2025-01-15T10:00:00Z' };
    const result = renderSummaryToMarkdown(s, 'test-project');
    assert.ok(result.full.includes('2025-01-15'));
    assert.ok(result.full.includes('UTC'));
  });

  it('renders project context', () => {
    const s = { ...emptyStructuredSummary(), projectContext: 'A memory plugin' };
    const result = renderSummaryToMarkdown(s, 'test-project');
    assert.ok(result.high.includes('## Project Context'));
    assert.ok(result.high.includes('A memory plugin'));
  });

  it('renders key decisions', () => {
    const s = {
      ...emptyStructuredSummary(),
      keyDecisions: [{ decision: 'Use ESM', reason: 'Modern' }]
    };
    const result = renderSummaryToMarkdown(s, 'test-project');
    assert.ok(result.high.includes('## Key Decisions'));
    assert.ok(result.high.includes('Use ESM'));
  });

  it('renders current state', () => {
    const s = {
      ...emptyStructuredSummary(),
      currentState: [{ topic: 'Login', status: 'In progress' }]
    };
    const result = renderSummaryToMarkdown(s, 'test-project');
    assert.ok(result.high.includes('## Current State'));
    assert.ok(result.high.includes('Login'));
  });

  it('filters stale completed state items', () => {
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    const s = {
      ...emptyStructuredSummary(),
      currentState: [{ topic: 'Old fix', status: 'completed', updatedAt: old }]
    };
    const result = renderSummaryToMarkdown(s, 'test-project');
    assert.ok(!result.high.includes('Old fix'));
  });

  it('renders recent work in medium priority', () => {
    const s = {
      ...emptyStructuredSummary(),
      recentWork: [{ date: new Date().toISOString().split('T')[0], summary: 'Added tests' }]
    };
    const result = renderSummaryToMarkdown(s, 'test-project');
    assert.ok(result.medium.includes('Added tests'));
  });

  it('filters old recent work by maxAgeDays', () => {
    const old = '2020-01-01';
    const s = {
      ...emptyStructuredSummary(),
      recentWork: [{ date: old, summary: 'Ancient work' }]
    };
    const result = renderSummaryToMarkdown(s, 'test-project');
    assert.ok(!result.medium.includes('Ancient work'));
  });

  it('respects section enabled=false', () => {
    const s = {
      ...emptyStructuredSummary(),
      projectContext: 'Should be hidden'
    };
    const result = renderSummaryToMarkdown(s, 'test-project', {
      sections: { projectContext: { enabled: false } }
    });
    assert.ok(!result.high.includes('Should be hidden'));
  });

  it('returns high, medium, and full keys', () => {
    const s = emptyStructuredSummary();
    const result = renderSummaryToMarkdown(s, 'test-project');
    assert.ok('high' in result);
    assert.ok('medium' in result);
    assert.ok('full' in result);
  });
});

describe('renderSummaryFull', () => {
  it('returns the full rendering as a string', () => {
    const s = { ...emptyStructuredSummary(), projectContext: 'Full test' };
    const result = renderSummaryFull(s, 'test-project');
    assert.equal(typeof result, 'string');
    assert.ok(result.includes('Full test'));
  });
});
