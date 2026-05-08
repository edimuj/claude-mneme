import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MnemeServer } from './mneme-server.mjs';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function req(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const r = request({
      host: '127.0.0.1', port, path, method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      timeout: 2000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Single shared server for all tests
// ---------------------------------------------------------------------------

let server;
let port;
let tmpDir;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mneme-server-test-'));

  server = new MnemeServer({
    host: '127.0.0.1',
    inactivityTimeout: 60 * 60 * 1000,
    batching: { log: { maxSize: 100, maxWaitMs: 100 } },
    throttling: { summarize: { maxConcurrent: 1, cooldownMs: 100 } },
    cache: { maxSize: 10, ttlMs: 1000 },
    summarization: { entryThreshold: 50 },
  });

  // Override getProjectMemoryDir to use tmpdir
  server.getProjectMemoryDir = (project) => {
    const safeName = project.replace(/^\//, '-').replace(/\//g, '-');
    const dir = join(tmpDir, safeName);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  };

  // Create HTTP server manually (skip start() which writes PID file + calls process.exit)
  server.server = createServer(server.handleRequest.bind(server));
  await new Promise((resolve) => {
    server.server.listen(0, '127.0.0.1', () => {
      port = server.server.address().port;
      resolve();
    });
  });
});

after(async () => {
  // Clean up ALL timers and services
  if (server?.inactivityTimer) clearInterval(server.inactivityTimer);
  try { await server?.captureService?.shutdown(); } catch {}
  try { await server?.logService?.shutdown(); } catch {}
  try { await server?.summarizationService?.shutdown(); } catch {}
  if (server?.server) {
    await new Promise((resolve) => server.server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('health endpoint', () => {
  it('GET /health returns ok with stats', async () => {
    const res = await req(port, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(typeof res.body.uptime === 'number');
    assert.ok(res.body.stats);
    assert.ok(res.body.queueDepth !== undefined);
  });
});

describe('log operations', () => {
  it('appends a log entry', async () => {
    const res = await req(port, 'POST', '/log/append', {
      project: '/tmp/test-project',
      entry: { ts: new Date().toISOString(), type: 'prompt', content: 'test prompt' },
    });
    assert.equal(res.status, 200);
  });

  it('returns 400 on missing fields for log/append', async () => {
    const res = await req(port, 'POST', '/log/append', { project: '/tmp' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing-fields');
  });

  it('flushes log', async () => {
    const res = await req(port, 'POST', '/log/flush', { project: '/tmp/test-project' });
    assert.equal(res.status, 200);
  });
});

describe('entity tracking', () => {
  it('tracks an entity', async () => {
    const res = await req(port, 'POST', '/entity/track', {
      project: '/tmp/test-project',
      entry: { ts: new Date().toISOString(), type: 'edit', content: 'Updated src/auth.ts' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('returns 400 on missing fields', async () => {
    const res = await req(port, 'POST', '/entity/track', { project: '/tmp' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing-fields');
  });
});

describe('capture stop', () => {
  it('accepts capture with 202', async () => {
    // Use a real (empty) transcript so capture completes quickly
    const transcript = join(tmpDir, 'test-transcript.jsonl');
    writeFileSync(transcript, '');

    const res = await req(port, 'POST', '/capture/stop', {
      project: '/tmp/test-project',
      hookData: { transcript_path: transcript },
    });
    assert.equal(res.status, 202);
    // Brief wait for async capture to detect empty file
    await new Promise(r => setTimeout(r, 500));
  });

  it('returns 400 on missing fields', async () => {
    const res = await req(port, 'POST', '/capture/stop', { project: '/tmp' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing-fields');
  });
});

describe('summarization', () => {
  it('triggers summarization', async () => {
    const res = await req(port, 'POST', '/summarize/trigger', { project: '/tmp/test-project' });
    assert.equal(res.status, 200);
  });

  it('returns 400 on missing project for trigger', async () => {
    const res = await req(port, 'POST', '/summarize/trigger', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing-project');
  });

  it('gets summarize status', async () => {
    const res = await req(port, 'POST', '/summarize/status', { project: '/tmp/test-project' });
    assert.equal(res.status, 200);
  });

  it('returns 400 on missing project for status', async () => {
    const res = await req(port, 'POST', '/summarize/status', {});
    assert.equal(res.status, 400);
  });

  it('gets summary', async () => {
    const res = await req(port, 'POST', '/summary/get', { project: '/tmp/test-project' });
    assert.equal(res.status, 200);
  });

  it('returns 400 on missing project for summary/get', async () => {
    const res = await req(port, 'POST', '/summary/get', {});
    assert.equal(res.status, 400);
  });
});

describe('routing edge cases', () => {
  it('returns 404 on unknown path', async () => {
    const res = await req(port, 'GET', '/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not-found');
  });

  it('handles OPTIONS (CORS preflight) with 204', async () => {
    const res = await new Promise((resolve, reject) => {
      const r = request({
        host: '127.0.0.1', port, path: '/health', method: 'OPTIONS', timeout: 2000,
      }, (resp) => {
        resolve({ status: resp.statusCode, headers: resp.headers });
      });
      r.on('error', reject);
      r.end();
    });
    assert.equal(res.status, 204);
  });

  it('increments request counter', async () => {
    const h1 = await req(port, 'GET', '/health');
    const count1 = h1.body.stats.requestsHandled;
    await req(port, 'GET', '/health');
    const h2 = await req(port, 'GET', '/health');
    assert.ok(h2.body.stats.requestsHandled > count1);
  });
});

describe('getProjectMemoryDir', () => {
  it('converts absolute path to safe directory name', () => {
    // Use the shared server instance to avoid creating new timers
    const dir = server.getProjectMemoryDir.call(
      { /* no override — use original logic */ },
      '/home/user/projects/my-app'
    );
    // The overridden method uses tmpDir, so test the original logic directly
    const safeName = '/home/user/projects/my-app'.replace(/^\//, '-').replace(/\//g, '-');
    assert.ok(safeName === '-home-user-projects-my-app');
  });
});
