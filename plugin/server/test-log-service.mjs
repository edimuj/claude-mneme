#!/usr/bin/env node
/**
 * Test suite for LogService (batching, deduplication, file writes)
 */

import { getClient } from '../client/mneme-client.mjs';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

const testProject = '/tmp/test-mneme-project';
const projectHash = createHash('sha256').update(testProject).digest('hex').slice(0, 16);
const projectDir = join(homedir(), '.claude-mneme', projectHash);
const logFile = join(projectDir, 'log.jsonl');

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
    testsPassed++;
  } else {
    console.log('  ✗', message);
    testsFailed++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (err) {
    console.log(`  ✗ Test failed:`, err.message);
    testsFailed++;
  }
}

async function cleanup() {
  // Clean up test project directory
  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true });
  }
}

async function runTests() {
  await cleanup();

  await test('Append single entry', async () => {
    const client = await getClient();

    const entry = {
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'Test entry 1'
    };

    const result = await client.appendLog(testProject, entry);
    assert(result.ok === true, 'Append succeeded');
    assert(result.queued === true, 'Entry queued');
    assert(result.deduplicated === false, 'Not deduplicated');

    // Wait for batch to flush
    await new Promise(r => setTimeout(r, 1500));

    assert(existsSync(logFile), 'Log file created');

    const logs = readFileSync(logFile, 'utf-8').trim().split('\n');
    assert(logs.length === 1, 'One entry written');

    const written = JSON.parse(logs[0]);
    assert(written.type === 'prompt', 'Correct type');
    assert(written.content === 'Test entry 1', 'Correct content');
  });

  await test('Batch multiple entries', async () => {
    await cleanup();
    const client = await getClient();

    // Send 5 entries quickly (don't await to keep them in same batch)
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(client.appendLog(testProject, {
        ts: new Date().toISOString(),
        type: 'prompt',
        content: `Test entry ${i}`
      }));
    }
    await Promise.all(promises);

    // Wait for batch flush
    await new Promise(r => setTimeout(r, 1500));

    const logs = readFileSync(logFile, 'utf-8').trim().split('\n');
    assert(logs.length === 5, `Five entries written (got ${logs.length})`);
  });

  await test('Deduplication within window', async () => {
    await cleanup();
    const client = await getClient();

    const entry = {
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'Duplicate entry'
    };

    // Send same entry 3 times quickly
    const result1 = await client.appendLog(testProject, entry);
    const result2 = await client.appendLog(testProject, entry);
    const result3 = await client.appendLog(testProject, entry);

    assert(result1.deduplicated === false, 'First not deduplicated');
    assert(result2.deduplicated === true, 'Second deduplicated');
    assert(result3.deduplicated === true, 'Third deduplicated');

    // Wait for batch flush
    await new Promise(r => setTimeout(r, 1500));

    const logs = readFileSync(logFile, 'utf-8').trim().split('\n');
    assert(logs.length === 1, 'Only one entry written (duplicates removed)');
  });

  await test('Force flush', async () => {
    await cleanup();
    const client = await getClient();

    // Send entry without waiting for batch timer
    await client.appendLog(testProject, {
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'Force flush test'
    });

    // Immediately force flush
    const flushResult = await client.flushLog(testProject);
    assert(flushResult.ok === true, 'Flush succeeded');

    // Should be written immediately
    assert(existsSync(logFile), 'Log file exists immediately');

    const logs = readFileSync(logFile, 'utf-8').trim().split('\n');
    assert(logs.length === 1, 'Entry written immediately');
  });

  await test('Health stats tracking', async () => {
    await cleanup();
    const client = await getClient();

    const healthBefore = await client.health();
    const receivedBefore = healthBefore.stats.log.entriesReceived;

    // Send some entries
    await client.appendLog(testProject, {
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'Stats test 1'
    });
    await client.appendLog(testProject, {
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'Stats test 2'
    });

    const healthAfter = await client.health();
    const receivedAfter = healthAfter.stats.log.entriesReceived;

    assert(receivedAfter === receivedBefore + 2, 'Stats incremented correctly');
    assert(healthAfter.queueDepth.log <= 2, 'Queue depth tracked');
  });

  await test('Multiple projects isolation', async () => {
    await cleanup();
    const client = await getClient();

    const project1 = '/tmp/test-project-1';
    const project2 = '/tmp/test-project-2';

    await client.appendLog(project1, {
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'Project 1 entry'
    });

    await client.appendLog(project2, {
      ts: new Date().toISOString(),
      type: 'prompt',
      content: 'Project 2 entry'
    });

    await new Promise(r => setTimeout(r, 1500));

    const hash1 = createHash('sha256').update(project1).digest('hex').slice(0, 16);
    const hash2 = createHash('sha256').update(project2).digest('hex').slice(0, 16);

    const log1 = join(homedir(), '.claude-mneme', hash1, 'log.jsonl');
    const log2 = join(homedir(), '.claude-mneme', hash2, 'log.jsonl');

    assert(existsSync(log1), 'Project 1 log exists');
    assert(existsSync(log2), 'Project 2 log exists');

    const logs1 = readFileSync(log1, 'utf-8').trim().split('\n');
    const logs2 = readFileSync(log2, 'utf-8').trim().split('\n');

    assert(logs1.length === 1, 'Project 1 has 1 entry');
    assert(logs2.length === 1, 'Project 2 has 1 entry');

    // Cleanup
    rmSync(join(homedir(), '.claude-mneme', hash1), { recursive: true });
    rmSync(join(homedir(), '.claude-mneme', hash2), { recursive: true });
  });

  await cleanup();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log(`${'='.repeat(50)}\n`);

  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
