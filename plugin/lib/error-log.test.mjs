import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getErrorLogPath,
  logError,
  getRecentErrors,
  clearErrorLog,
  getErrorsSince
} from './error-log.mjs';

describe('getErrorLogPath', () => {
  it('returns a path ending with errors.log', () => {
    const p = getErrorLogPath();
    assert.ok(p.endsWith('errors.log'));
  });

  it('returns a path under .claude-mneme', () => {
    const p = getErrorLogPath();
    assert.ok(p.includes('.claude-mneme'));
  });
});

describe('logError', () => {
  it('does not throw on Error input', () => {
    assert.doesNotThrow(() => logError(new Error('test error'), 'unit-test'));
  });

  it('does not throw on string input', () => {
    assert.doesNotThrow(() => logError('string error', 'unit-test'));
  });

  it('does not throw when context is omitted', () => {
    assert.doesNotThrow(() => logError('no context'));
  });
});

describe('getRecentErrors', () => {
  it('returns an array', () => {
    const errors = getRecentErrors();
    assert.ok(Array.isArray(errors));
  });

  it('respects maxCount parameter', () => {
    const errors = getRecentErrors(1);
    assert.ok(errors.length <= 1);
  });

  it('returns most recent first', () => {
    const errors = getRecentErrors(10);
    if (errors.length >= 2) {
      const first = new Date(errors[0].ts).getTime();
      const second = new Date(errors[1].ts).getTime();
      assert.ok(first >= second, 'First error should be more recent');
    }
  });
});

describe('clearErrorLog', () => {
  it('returns a boolean', () => {
    const result = clearErrorLog();
    assert.equal(typeof result, 'boolean');
  });
});

describe('getErrorsSince', () => {
  it('returns an array', () => {
    const errors = getErrorsSince(24);
    assert.ok(Array.isArray(errors));
  });

  it('filters by time window', () => {
    const errors = getErrorsSince(0);
    assert.equal(errors.length, 0, 'Zero hours window should return no errors');
  });
});
