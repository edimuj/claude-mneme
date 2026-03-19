import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LogService } from './log-service.mjs';

const nullLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe('LogService deduplication', () => {
  let service;

  afterEach(async () => {
    if (service) {
      await service.shutdown();
      service = null;
    }
  });

  it('keeps identical entries isolated by project', async () => {
    const writes = [];

    service = new LogService({
      batching: { log: { maxSize: 10, maxWaitMs: 1000 } }
    }, nullLogger);

    service.writeToLog = (project, entries) => {
      writes.push({ project, entries });
    };

    const entry = {
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'same content'
    };

    const first = service.append('/tmp/project-a', entry);
    const second = service.append('/tmp/project-b', entry);

    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, false);

    await service.flush();

    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map(({ project, entries }) => ({ project, count: entries.length })),
      [
        { project: '/tmp/project-a', count: 1 },
        { project: '/tmp/project-b', count: 1 }
      ]
    );
  });

  it('still deduplicates rapid duplicates within the same project', async () => {
    const writes = [];

    service = new LogService({
      batching: { log: { maxSize: 10, maxWaitMs: 1000 } }
    }, nullLogger);

    service.writeToLog = (project, entries) => {
      writes.push({ project, entries });
    };

    const entry = {
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'same content'
    };

    const first = service.append('/tmp/project-a', entry);
    const second = service.append('/tmp/project-a', entry);

    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);

    await service.flush();

    assert.equal(writes.length, 1);
    assert.equal(writes[0].project, '/tmp/project-a');
    assert.equal(writes[0].entries.length, 1);
  });
});
