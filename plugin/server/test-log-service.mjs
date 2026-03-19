import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getClient } from '../client/mneme-client.mjs';

function projectDirFor(project) {
  const safeName = project.replace(/^\//, '-').replace(/\//g, '-');
  return join(homedir(), '.claude-mneme', 'projects', safeName);
}

function logFileFor(project) {
  return join(projectDirFor(project), 'log.jsonl');
}

async function appendAndFlush(project, entries) {
  const client = await getClient();
  await Promise.all(entries.map((entry) => client.appendLog(project, entry)));
  await client.flushLog(project);
  return client;
}

function readLogEntries(project) {
  const logFile = logFileFor(project);
  if (!existsSync(logFile)) {
    return [];
  }

  const content = readFileSync(logFile, 'utf-8').trim();
  if (!content) {
    return [];
  }

  return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function cleanupProject(project) {
  rmSync(projectDirFor(project), { recursive: true, force: true });
}

const projectsToCleanup = new Set();

afterEach(() => {
  for (const project of projectsToCleanup) {
    cleanupProject(project);
  }
  projectsToCleanup.clear();
});

describe('LogService integration', () => {
  it('appends a single entry', async () => {
    const project = `/tmp/test-mneme-project-${randomUUID()}`;
    projectsToCleanup.add(project);

    const entry = {
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'Test entry 1'
    };

    const client = await getClient();
    const result = await client.appendLog(project, entry);
    assert.equal(result.ok, true);
    assert.equal(result.queued, true);
    assert.equal(result.deduplicated, false);

    await client.flushLog(project);

    const logs = readLogEntries(project);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].type, 'prompt');
    assert.equal(logs[0].content, 'Test entry 1');
  });

  it('batches multiple entries deterministically', async () => {
    const project = `/tmp/test-mneme-project-${randomUUID()}`;
    projectsToCleanup.add(project);

    await appendAndFlush(project, Array.from({ length: 5 }, (_, i) => ({
      ts: new Date().toISOString(),
      type: 'prompt',
      content: `Test entry ${i}`
    })));

    const logs = readLogEntries(project);
    assert.equal(logs.length, 5);
  });

  it('deduplicates rapid duplicates within the same project', async () => {
    const project = `/tmp/test-mneme-project-${randomUUID()}`;
    projectsToCleanup.add(project);
    const client = await getClient();

    const entry = {
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'Duplicate entry'
    };

    const result1 = await client.appendLog(project, entry);
    const result2 = await client.appendLog(project, entry);
    const result3 = await client.appendLog(project, entry);

    assert.equal(result1.deduplicated, false);
    assert.equal(result2.deduplicated, true);
    assert.equal(result3.deduplicated, true);

    await client.flushLog(project);

    const logs = readLogEntries(project);
    assert.equal(logs.length, 1);
  });

  it('flushes immediately on demand', async () => {
    const project = `/tmp/test-mneme-project-${randomUUID()}`;
    projectsToCleanup.add(project);
    const client = await getClient();

    await client.appendLog(project, {
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'Force flush test'
    });

    const flushResult = await client.flushLog(project);
    assert.equal(flushResult.ok, true);

    const logs = readLogEntries(project);
    assert.equal(logs.length, 1);
  });

  it('reports health stats and timings', async () => {
    const project = `/tmp/test-mneme-project-${randomUUID()}`;
    projectsToCleanup.add(project);
    const client = await getClient();

    const healthBefore = await client.health();
    const receivedBefore = healthBefore.stats.log.entriesReceived;

    await appendAndFlush(project, [
      { ts: new Date().toISOString(), type: 'prompt', content: 'Stats test 1' },
      { ts: new Date().toISOString(), type: 'prompt', content: 'Stats test 2' }
    ]);

    const healthAfter = await client.health();
    assert.equal(healthAfter.stats.log.entriesReceived, receivedBefore + 2);
    assert.ok(healthAfter.queueDepth.log >= 0);
    assert.ok(healthAfter.timings.logFlushMs);
    assert.ok(healthAfter.timings.summarizationThresholdCheckMs);
    assert.ok(healthAfter.timings.entityBatchUpdateMs);
  });

  it('keeps identical entries isolated across projects', async () => {
    const project1 = `/tmp/test-project-1-${randomUUID()}`;
    const project2 = `/tmp/test-project-2-${randomUUID()}`;
    projectsToCleanup.add(project1);
    projectsToCleanup.add(project2);

    await appendAndFlush(project1, [{
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'Shared content'
    }]);

    await appendAndFlush(project2, [{
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'Shared content'
    }]);

    assert.equal(readLogEntries(project1).length, 1);
    assert.equal(readLogEntries(project2).length, 1);
  });
});
