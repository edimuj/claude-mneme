import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BatchQueue } from './batch-queue.mjs';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

describe('BatchQueue', () => {
  it('drains a full batch added while an earlier flush is in flight', async () => {
    const firstFlushGate = createDeferred();
    const calls = [];

    const queue = new BatchQueue({
      maxSize: 2,
      maxWaitMs: 1000,
      processor: async (items) => {
        calls.push(items.map((item) => item.id));
        if (calls.length === 1) {
          await firstFlushGate.promise;
        }
      }
    });

    queue.add({ id: 1 });
    queue.add({ id: 2 });

    await waitFor(() => calls.length === 1);

    queue.add({ id: 3 });
    queue.add({ id: 4 });

    firstFlushGate.resolve();

    await waitFor(() => calls.length === 2);

    assert.deepEqual(calls, [[1, 2], [3, 4]]);
    assert.equal(queue.depth(), 0);

    await queue.shutdown();
  });
});
