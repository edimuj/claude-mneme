import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main as runSessionStop } from './session-stop.mjs';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('session-stop', () => {
  it('awaits summarize dispatch before completing when it resolves within timeout', async () => {
    const steps = [];
    const deferred = createDeferred();
    let completed = false;

    const runPromise = runSessionStop({
      cwd: '/tmp/project',
      summarizeTimeoutMs: 1000,
      loadConfigFn: () => ({}),
      stopHeartbeatFn: () => steps.push('stopHeartbeat'),
      flushPendingLogFn: () => steps.push('flushPendingLog'),
      maybeSummarizeFn: () => {
        steps.push('maybeSummarize:start');
        return deferred.promise.then(() => {
          steps.push('maybeSummarize:done');
        });
      },
      pushIfEnabledFn: async () => {
        steps.push('pushIfEnabled');
      }
    }).then(() => {
      completed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(completed, false);
    assert.deepEqual(steps, [
      'stopHeartbeat',
      'flushPendingLog',
      'maybeSummarize:start'
    ]);

    deferred.resolve();
    await runPromise;

    assert.deepEqual(steps, [
      'stopHeartbeat',
      'flushPendingLog',
      'maybeSummarize:start',
      'maybeSummarize:done',
      'pushIfEnabled'
    ]);
  });

  it('continues after bounded timeout if summarize dispatch hangs', async () => {
    const steps = [];
    const deferred = createDeferred();
    const start = Date.now();

    await runSessionStop({
      cwd: '/tmp/project',
      summarizeTimeoutMs: 30,
      loadConfigFn: () => ({}),
      stopHeartbeatFn: () => steps.push('stopHeartbeat'),
      flushPendingLogFn: () => steps.push('flushPendingLog'),
      maybeSummarizeFn: () => {
        steps.push('maybeSummarize:start');
        return deferred.promise;
      },
      pushIfEnabledFn: async () => {
        steps.push('pushIfEnabled');
      }
    });

    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 20, `expected timeout delay, got ${elapsed}ms`);
    assert.deepEqual(steps, [
      'stopHeartbeat',
      'flushPendingLog',
      'maybeSummarize:start',
      'pushIfEnabled'
    ]);
  });
});
