#!/usr/bin/env node
/**
 * Test suite for Mneme Server
 */

import { getClient } from '../client/mneme-client.mjs';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PID_FILE = join(homedir(), '.claude-mneme', '.server.pid');

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

async function runTests() {
  await test('Server auto-start', async () => {
    const client = await getClient();
    assert(client !== null, 'Client created');
    assert(existsSync(PID_FILE), 'PID file exists');

    const { pid, port, host } = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
    assert(typeof pid === 'number', 'PID is a number');
    assert(typeof port === 'number', 'Port is a number');
    assert(host === '127.0.0.1', 'Host is localhost');
  });

  await test('Health endpoint', async () => {
    const client = await getClient();
    const health = await client.health();

    assert(health.ok === true, 'Health status is ok');
    assert(typeof health.uptime === 'number', 'Uptime is a number');
    assert(health.activeSessions === 0, 'No active sessions initially');
    assert(typeof health.stats.requestsHandled === 'number', 'Request count tracked');
  });

  await test('Session registration', async () => {
    const client = await getClient();
    const sessionId = randomUUID();

    await client.registerSession(sessionId, '/test/path');
    const health = await client.health();
    assert(health.activeSessions === 1, 'Active sessions increased');

    await client.unregisterSession(sessionId);
    const health2 = await client.health();
    assert(health2.activeSessions === 0, 'Active sessions decreased');
  });

  await test('Multiple sessions', async () => {
    const client = await getClient();
    const sessions = [randomUUID(), randomUUID(), randomUUID()];

    for (const id of sessions) {
      await client.registerSession(id, '/test');
    }

    const health = await client.health();
    assert(health.activeSessions === 3, 'Three active sessions');

    for (const id of sessions) {
      await client.unregisterSession(id);
    }

    const health2 = await client.health();
    assert(health2.activeSessions === 0, 'All sessions unregistered');
  });

  await test('Server reuse', async () => {
    const client1 = await getClient();
    const health1 = await client1.health();
    const reqCount1 = health1.stats.requestsHandled;

    // Second client should reuse same server
    const client2 = await getClient();
    const health2 = await client2.health();

    assert(health2.stats.requestsHandled > reqCount1, 'Same server instance reused');
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log(`${'='.repeat(50)}\n`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
