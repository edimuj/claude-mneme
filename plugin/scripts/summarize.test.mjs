import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { buildPaths, applyUpdates } from './summarize.mjs';

// ---------------------------------------------------------------------------
// buildPaths
// ---------------------------------------------------------------------------

describe('buildPaths', () => {
  it('returns expected file paths', () => {
    const p = buildPaths('/home/user/.claude-mneme/projects/-my-project');
    assert.equal(p.project, '/home/user/.claude-mneme/projects/-my-project');
    assert.equal(p.log, '/home/user/.claude-mneme/projects/-my-project/log.jsonl');
    assert.equal(p.summary, '/home/user/.claude-mneme/projects/-my-project/summary.md');
    assert.equal(p.summaryJson, '/home/user/.claude-mneme/projects/-my-project/summary.json');
    assert.equal(p.remembered, '/home/user/.claude-mneme/projects/-my-project/remembered.json');
    assert.equal(p.entities, '/home/user/.claude-mneme/projects/-my-project/entities.json');
    assert.equal(p.cache, '/home/user/.claude-mneme/projects/-my-project/.cache.json');
    assert.equal(p.handoff, '/home/user/.claude-mneme/projects/-my-project/handoff.json');
  });

  it('includes base and config paths', () => {
    const p = buildPaths('/some/path');
    assert.equal(p.base, join(homedir(), '.claude-mneme'));
    assert.equal(p.config, join(homedir(), '.claude-mneme', 'config.json'));
  });
});

// ---------------------------------------------------------------------------
// applyUpdates
// ---------------------------------------------------------------------------

describe('applyUpdates — project context', () => {
  it('updates projectContext when provided', () => {
    const existing = { projectContext: 'Old context', keyDecisions: [], currentState: [], recentWork: [] };
    const updates = { projectContext: 'New context' };
    const result = applyUpdates(existing, updates);
    assert.equal(result.projectContext, 'New context');
  });

  it('keeps existing projectContext when update is null', () => {
    const existing = { projectContext: 'Original', keyDecisions: [], currentState: [], recentWork: [] };
    const updates = { projectContext: null };
    const result = applyUpdates(existing, updates);
    assert.equal(result.projectContext, 'Original');
  });
});

describe('applyUpdates — key decisions', () => {
  it('appends new decisions', () => {
    const existing = {
      keyDecisions: [{ decision: 'Use ESM', foundational: true }],
      currentState: [],
      recentWork: [],
    };
    const updates = {
      newKeyDecisions: [{ decision: 'Use Redis', foundational: false }],
    };
    const result = applyUpdates(existing, updates);
    assert.equal(result.keyDecisions.length, 2);
    assert.equal(result.keyDecisions[1].decision, 'Use Redis');
  });

  it('caps at 10 decisions, pruning tactical first', () => {
    const existing = {
      keyDecisions: [
        ...Array(6).fill(null).map((_, i) => ({ decision: `Foundational ${i}`, foundational: true })),
        ...Array(3).fill(null).map((_, i) => ({ decision: `Tactical ${i}`, foundational: false })),
      ],
      currentState: [],
      recentWork: [],
    };
    const updates = {
      newKeyDecisions: [
        { decision: 'New tactical 1', foundational: false },
        { decision: 'New tactical 2', foundational: false },
      ],
    };
    const result = applyUpdates(existing, updates);
    assert.ok(result.keyDecisions.length <= 10);
    // Foundational decisions should be preserved
    const foundational = result.keyDecisions.filter(d => d.foundational);
    assert.equal(foundational.length, 6);
  });

  it('prunes oldest foundational when not enough tactical', () => {
    const existing = {
      keyDecisions: Array(10).fill(null).map((_, i) => ({ decision: `Foundational ${i}`, foundational: true })),
      currentState: [],
      recentWork: [],
    };
    const updates = {
      newKeyDecisions: [{ decision: 'New', foundational: true }],
    };
    const result = applyUpdates(existing, updates);
    assert.ok(result.keyDecisions.length <= 10);
    // Should have dropped the oldest foundational
    assert.ok(!result.keyDecisions.some(d => d.decision === 'Foundational 0'));
  });

  it('handles no existing decisions', () => {
    const existing = { currentState: [], recentWork: [] };
    const updates = { newKeyDecisions: [{ decision: 'First', foundational: true }] };
    const result = applyUpdates(existing, updates);
    assert.equal(result.keyDecisions.length, 1);
  });
});

describe('applyUpdates — current state', () => {
  it('merges by topic (upsert)', () => {
    const existing = {
      keyDecisions: [],
      currentState: [{ topic: 'Auth', status: 'In progress' }],
      recentWork: [],
    };
    const updates = {
      updateCurrentState: [{ topic: 'Auth', status: 'Complete' }],
    };
    const result = applyUpdates(existing, updates);
    assert.equal(result.currentState.length, 1);
    assert.equal(result.currentState[0].status, 'Complete');
    assert.ok(result.currentState[0].updatedAt);
  });

  it('adds new topics', () => {
    const existing = {
      keyDecisions: [],
      currentState: [{ topic: 'Auth', status: 'Done' }],
      recentWork: [],
    };
    const updates = {
      updateCurrentState: [{ topic: 'Dashboard', status: 'New' }],
    };
    const result = applyUpdates(existing, updates);
    assert.equal(result.currentState.length, 2);
  });

  it('caps at 15 items', () => {
    const existing = {
      keyDecisions: [],
      currentState: Array(14).fill(null).map((_, i) => ({ topic: `Topic ${i}`, status: 'ok' })),
      recentWork: [],
    };
    const updates = {
      updateCurrentState: [
        { topic: 'New 1', status: 'ok' },
        { topic: 'New 2', status: 'ok' },
      ],
    };
    const result = applyUpdates(existing, updates);
    assert.ok(result.currentState.length <= 15);
  });
});

describe('applyUpdates — recent work', () => {
  it('adds new recent work', () => {
    const existing = {
      keyDecisions: [],
      currentState: [],
      recentWork: [{ date: '2026-01-01', summary: 'Old work' }],
    };
    const updates = {
      newRecentWork: [{ date: '2026-01-02', summary: 'New work' }],
    };
    const result = applyUpdates(existing, updates);
    assert.equal(result.recentWork.length, 2);
  });

  it('removes stale items by index', () => {
    const existing = {
      keyDecisions: [],
      currentState: [],
      recentWork: [
        { date: '2026-01-01', summary: 'Stale' },
        { date: '2026-01-02', summary: 'Keep' },
        { date: '2026-01-03', summary: 'Also stale' },
      ],
    };
    const updates = { removeFromRecentWork: [0, 2] };
    const result = applyUpdates(existing, updates);
    assert.equal(result.recentWork.length, 1);
    assert.equal(result.recentWork[0].summary, 'Keep');
  });

  it('promotes items to current state', () => {
    const existing = {
      keyDecisions: [],
      currentState: [],
      recentWork: [
        { date: '2026-01-01', summary: 'Completed auth refactor' },
        { date: '2026-01-02', summary: 'In progress' },
      ],
    };
    const updates = { promoteToCurrentState: [0] };
    const result = applyUpdates(existing, updates);
    // Promoted item should be in currentState
    assert.ok(result.currentState.some(s => s.status.includes('Completed auth refactor')));
    // And removed from recentWork
    assert.equal(result.recentWork.length, 1);
    assert.equal(result.recentWork[0].summary, 'In progress');
  });

  it('caps at 10 recent work items', () => {
    const existing = {
      keyDecisions: [],
      currentState: [],
      recentWork: Array(9).fill(null).map((_, i) => ({ summary: `Work ${i}` })),
    };
    const updates = {
      newRecentWork: Array(5).fill(null).map((_, i) => ({ summary: `New ${i}` })),
    };
    const result = applyUpdates(existing, updates);
    assert.ok(result.recentWork.length <= 10);
  });

  it('keeps most recent items when capping', () => {
    const existing = {
      keyDecisions: [],
      currentState: [],
      recentWork: Array(8).fill(null).map((_, i) => ({ summary: `Old ${i}` })),
    };
    const updates = {
      newRecentWork: Array(5).fill(null).map((_, i) => ({ summary: `New ${i}` })),
    };
    const result = applyUpdates(existing, updates);
    // Should have the newest items
    assert.ok(result.recentWork.some(r => r.summary === 'New 4'));
  });
});

describe('applyUpdates — combined operations', () => {
  it('handles all update types in one call', () => {
    const existing = {
      projectContext: 'A project',
      keyDecisions: [{ decision: 'Use ESM', foundational: true }],
      currentState: [{ topic: 'Auth', status: 'WIP' }],
      recentWork: [{ date: '2026-01-01', summary: 'Started auth' }],
    };
    const updates = {
      projectContext: 'An updated project',
      newKeyDecisions: [{ decision: 'Use Redis', foundational: false }],
      updateCurrentState: [{ topic: 'Auth', status: 'Done' }],
      newRecentWork: [{ date: '2026-01-02', summary: 'Deployed auth' }],
      removeFromRecentWork: [0],
    };
    const result = applyUpdates(existing, updates);
    assert.equal(result.projectContext, 'An updated project');
    assert.equal(result.keyDecisions.length, 2);
    assert.equal(result.currentState[0].status, 'Done');
    assert.equal(result.recentWork.length, 1);
    assert.equal(result.recentWork[0].summary, 'Deployed auth');
  });

  it('sets lastUpdated', () => {
    const existing = { keyDecisions: [], currentState: [], recentWork: [] };
    const result = applyUpdates(existing, {});
    assert.ok(result.lastUpdated);
    assert.ok(new Date(result.lastUpdated).getTime() > Date.now() - 5000);
  });

  it('handles empty updates gracefully', () => {
    const existing = {
      projectContext: 'Existing',
      keyDecisions: [{ decision: 'A' }],
      currentState: [{ topic: 'B', status: 'C' }],
      recentWork: [{ summary: 'D' }],
    };
    const result = applyUpdates(existing, {});
    assert.equal(result.projectContext, 'Existing');
    assert.equal(result.keyDecisions.length, 1);
    assert.equal(result.currentState.length, 1);
    assert.equal(result.recentWork.length, 1);
  });
});
