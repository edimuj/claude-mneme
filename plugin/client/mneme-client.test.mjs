import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MnemeClient } from './mneme-client.mjs';

// ---------------------------------------------------------------------------
// Mock server — simulates Mneme Plugin Service responses
// ---------------------------------------------------------------------------

let mockServer;
let mockPort;
let lastRequest; // { method, path, body }

function startMockServer(handler) {
  return new Promise((resolve) => {
    mockServer = createServer(async (req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          lastRequest = {
            method: req.method,
            path: req.url,
            body: body ? JSON.parse(body) : null,
            headers: req.headers,
          };
        } catch {
          lastRequest = { method: req.method, path: req.url, body: null, headers: req.headers };
        }
        handler(req, res, lastRequest);
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
}

function stopMockServer() {
  return new Promise((resolve) => {
    if (mockServer) mockServer.close(resolve);
    else resolve();
  });
}

// ---------------------------------------------------------------------------
// MnemeClient — request plumbing
// ---------------------------------------------------------------------------

describe('MnemeClient — request plumbing', () => {
  before(async () => {
    await startMockServer((_req, res, parsed) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: parsed.body }));
    });
  });

  after(async () => {
    await stopMockServer();
  });

  it('sends GET requests correctly', async () => {
    const client = new MnemeClient('127.0.0.1', mockPort);
    const result = await client.get('/health');
    assert.equal(result.ok, true);
    assert.equal(lastRequest.method, 'GET');
    assert.equal(lastRequest.path, '/health');
  });

  it('sends POST requests with JSON body', async () => {
    const client = new MnemeClient('127.0.0.1', mockPort);
    const result = await client.post('/log/append', { project: '/tmp/test', entry: { type: 'test' } });
    assert.equal(result.ok, true);
    assert.equal(lastRequest.method, 'POST');
    assert.equal(lastRequest.path, '/log/append');
    assert.deepEqual(lastRequest.body, { project: '/tmp/test', entry: { type: 'test' } });
    assert.equal(lastRequest.headers['content-type'], 'application/json');
  });

  it('sends POST without content-type when no body', async () => {
    const client = new MnemeClient('127.0.0.1', mockPort);
    await client.request('POST', '/test', null);
    assert.equal(lastRequest.headers['content-type'], undefined);
  });
});

// ---------------------------------------------------------------------------
// MnemeClient — API methods route correctly
// ---------------------------------------------------------------------------

describe('MnemeClient — API methods', () => {
  before(async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  after(async () => {
    await stopMockServer();
  });

  it('health() sends GET /health', async () => {
    const client = new MnemeClient('127.0.0.1', mockPort);
    await client.health();
    assert.equal(lastRequest.method, 'GET');
    assert.equal(lastRequest.path, '/health');
  });

  // Note: session register/unregister was removed in 784d0af (dead session
  // tracking). No client methods or server routes exist for it any more.

  it('trackEntity() sends POST /entity/track', async () => {
    const client = new MnemeClient('127.0.0.1', mockPort);
    await client.trackEntity('/tmp/proj', { type: 'edit', content: 'src/a.ts' });
    assert.equal(lastRequest.path, '/entity/track');
    assert.equal(lastRequest.body.project, '/tmp/proj');
    assert.equal(lastRequest.body.entry.type, 'edit');
  });

  it('appendLog() sends POST /log/append', async () => {
    const client = new MnemeClient('127.0.0.1', mockPort);
    await client.appendLog('/tmp/proj', { ts: '2026-01-01', type: 'prompt', content: 'test' });
    assert.equal(lastRequest.path, '/log/append');
    assert.equal(lastRequest.body.project, '/tmp/proj');
  });

  it('captureStop() sends POST /capture/stop', async () => {
    const client = new MnemeClient('127.0.0.1', mockPort);
    await client.captureStop('/tmp/proj', { transcript_path: '/tmp/t.jsonl' });
    assert.equal(lastRequest.path, '/capture/stop');
    assert.deepEqual(lastRequest.body, { project: '/tmp/proj', hookData: { transcript_path: '/tmp/t.jsonl' } });
  });

  it('flushLog() sends POST /log/flush', async () => {
    const client = new MnemeClient('127.0.0.1', mockPort);
    await client.flushLog('/tmp/proj');
    assert.equal(lastRequest.path, '/log/flush');
    assert.deepEqual(lastRequest.body, { project: '/tmp/proj' });
  });

  it('flushLog() with no project sends null', async () => {
    const client = new MnemeClient('127.0.0.1', mockPort);
    await client.flushLog();
    assert.deepEqual(lastRequest.body, { project: null });
  });

  it('triggerSummarize() sends POST /summarize/trigger', async () => {
    const client = new MnemeClient('127.0.0.1', mockPort);
    await client.triggerSummarize('/tmp/proj', true);
    assert.equal(lastRequest.path, '/summarize/trigger');
    assert.deepEqual(lastRequest.body, { project: '/tmp/proj', force: true });
  });

  it('getSummarizeStatus() sends POST /summarize/status', async () => {
    const client = new MnemeClient('127.0.0.1', mockPort);
    await client.getSummarizeStatus('/tmp/proj');
    assert.equal(lastRequest.path, '/summarize/status');
    assert.equal(lastRequest.body.project, '/tmp/proj');
  });

  it('getSummary() sends POST /summary/get', async () => {
    const client = new MnemeClient('127.0.0.1', mockPort);
    await client.getSummary('/tmp/proj');
    assert.equal(lastRequest.path, '/summary/get');
    assert.equal(lastRequest.body.project, '/tmp/proj');
  });
});

// ---------------------------------------------------------------------------
// MnemeClient — error handling
// ---------------------------------------------------------------------------

describe('MnemeClient — error handling', () => {
  it('rejects on HTTP 4xx with error message', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing-fields' }));
    });

    const client = new MnemeClient('127.0.0.1', mockPort);
    await assert.rejects(
      () => client.post('/log/append', {}),
      (err) => {
        assert.ok(err.message.includes('missing-fields'));
        return true;
      }
    );
    await stopMockServer();
  });

  it('rejects on HTTP 500 with error message', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal-server-error' }));
    });

    const client = new MnemeClient('127.0.0.1', mockPort);
    await assert.rejects(
      () => client.get('/health'),
      (err) => {
        assert.ok(err.message.includes('internal-server-error'));
        return true;
      }
    );
    await stopMockServer();
  });

  it('rejects on invalid JSON response', async () => {
    await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not json');
    });

    const client = new MnemeClient('127.0.0.1', mockPort);
    await assert.rejects(
      () => client.get('/health'),
      (err) => {
        assert.ok(err.message.includes('Invalid JSON'));
        return true;
      }
    );
    await stopMockServer();
  });

  it('rejects on connection refused', async () => {
    const client = new MnemeClient('127.0.0.1', 1); // port 1 — nothing listens
    await assert.rejects(
      () => client.get('/health'),
      (err) => {
        assert.ok(err.message.includes('ECONNREFUSED') || err.code === 'ECONNREFUSED' || err.message.includes('EACCES'));
        return true;
      }
    );
  });

  it('rejects on timeout', async () => {
    await startMockServer((_req, _res) => {
      // Never respond — causes timeout
    });

    const client = new MnemeClient('127.0.0.1', mockPort);
    client.timeout = 100; // 100ms timeout for fast test
    await assert.rejects(
      () => client.get('/health'),
      (err) => {
        assert.ok(err.message.includes('timeout'));
        return true;
      }
    );
    await stopMockServer();
  });
});

// ---------------------------------------------------------------------------
// MnemeClient — constructor
// ---------------------------------------------------------------------------

describe('MnemeClient — constructor', () => {
  it('stores host and port', () => {
    const client = new MnemeClient('localhost', 9999);
    assert.equal(client.host, 'localhost');
    assert.equal(client.port, 9999);
    assert.equal(client.timeout, 2000);
  });
});
