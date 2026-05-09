/**
 * Mneme Client
 *
 * Thin HTTP client for hooks to communicate with the Mneme server.
 * Handles auto-start of server if not running.
 */

import { request } from 'http';
import { existsSync, readFileSync, unlinkSync, openSync, closeSync, statSync, constants as fsConstants } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MEMORY_BASE = join(homedir(), '.claude-mneme');
const PID_FILE = join(MEMORY_BASE, '.server.pid');
const LOCK_FILE = join(MEMORY_BASE, '.server.startup.lock');
const SERVER_SCRIPT = join(__dirname, '../server/mneme-server.mjs');

function extractVersion(scriptPath) {
  const m = scriptPath && scriptPath.match(/claude-mneme\/([^/]+)\/server\//);
  return m ? m[1] : scriptPath;
}

function tryAcquireLock() {
  try {
    const fd = openSync(LOCK_FILE, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      try {
        const stat = statSync(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > 10000) {
          unlinkSync(LOCK_FILE);
          return tryAcquireLock();
        }
      } catch {}
      return false;
    }
    return false;
  }
}

/**
 * Check if server is running and responsive
 */
async function pingServer(host, port) {
  return new Promise((resolve) => {
    const req = request({
      host,
      port,
      path: '/health',
      method: 'GET',
      timeout: 1000
    }, (res) => {
      resolve(res.statusCode === 200);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

/**
 * Ensure server is running, start if needed
 * Returns { host, port }
 */
export async function ensureServer() {
  // Check if server is already running
  if (existsSync(PID_FILE)) {
    try {
      const pidData = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
      const { pid, host, port } = pidData;

      // Verify process is alive
      try {
        process.kill(pid, 0); // Signal 0 = check existence
      } catch {
        // Process dead, clean up stale PID file
        try { unlinkSync(PID_FILE); } catch {}
        return ensureServer(); // Retry
      }

      // Check for version mismatch (plugin was reinstalled/upgraded)
      // Compare extracted versions, not full paths — different rigs have different paths for the same code
      if (extractVersion(pidData.serverScript) !== extractVersion(SERVER_SCRIPT)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
        try { unlinkSync(PID_FILE); } catch {}
        // Brief pause for the old process to release the port
        await new Promise(r => setTimeout(r, 200));
        return ensureServer(); // Restart with current version
      }

      // Verify server is responsive
      if (await pingServer(host, port)) {
        return { host, port };
      }

      // Server not responsive, clean up and retry
      try { unlinkSync(PID_FILE); } catch {}
      return ensureServer();
    } catch (e) {
      // Invalid PID file, clean up
      try { unlinkSync(PID_FILE); } catch {}
      return ensureServer();
    }
  }

  // Acquire startup lock — only one client should spawn a server
  if (!tryAcquireLock()) {
    // Another client is spawning — wait for it to finish
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (existsSync(PID_FILE)) {
        try {
          const { host, port } = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
          if (await pingServer(host, port)) return { host, port };
        } catch {}
      }
    }
    throw new Error('Server failed to start (another client is spawning)');
  }

  // Double-check PID file after acquiring lock (another server may have started)
  if (existsSync(PID_FILE)) {
    try { unlinkSync(LOCK_FILE); } catch {}
    return ensureServer();
  }

  // Start server (detached process)
  const child = spawn('node', [SERVER_SCRIPT], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  // Wait for server to be ready (max 3 seconds)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));

    if (existsSync(PID_FILE)) {
      try {
        const { host, port } = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
        if (await pingServer(host, port)) {
          try { unlinkSync(LOCK_FILE); } catch {}
          return { host, port };
        }
      } catch {
        // Not ready yet, continue waiting
      }
    }
  }

  try { unlinkSync(LOCK_FILE); } catch {}
  throw new Error('Server failed to start within 3 seconds');
}

const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ERR_SOCKET_CONNECTION_TIMEOUT']);

/**
 * HTTP client for the Mneme server
 */
export class MnemeClient {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.timeout = 2000; // 2 second timeout
  }

  _rawRequest(method, path, body, host, port) {
    return new Promise((resolve, reject) => {
      const options = {
        host: host || this.host,
        port: port || this.port,
        path,
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        timeout: this.timeout
      };

      const req = request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Make HTTP request to server, with one retry on connection errors.
   * On retry, re-reads the PID file to pick up a new server port
   * (handles the version-upgrade window where the old server is killed).
   */
  async request(method, path, body = null) {
    try {
      return await this._rawRequest(method, path, body);
    } catch (err) {
      const code = err.code || '';
      const msg = err.message || '';
      const isRetryable = RETRYABLE_CODES.has(code)
        || msg === 'socket hang up'
        || msg === 'Invalid JSON response';

      if (!isRetryable) throw err;

      // Re-discover server (it may have restarted on a new port)
      try {
        const pidData = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
        if (await pingServer(pidData.host, pidData.port)) {
          this.host = pidData.host;
          this.port = pidData.port;
          return await this._rawRequest(method, path, body, pidData.host, pidData.port);
        }
      } catch { /* PID file gone or unreadable */ }

      throw err;
    }
  }

  /**
   * POST request helper
   */
  async post(path, body) {
    return this.request('POST', path, body);
  }

  /**
   * GET request helper
   */
  async get(path) {
    return this.request('GET', path);
  }

  // Health Check

  async health() {
    return this.get('/health');
  }

  // Entity Operations

  async trackEntity(project, entry) {
    return this.post('/entity/track', { project, entry });
  }

  // Log Operations

  async appendLog(project, entry) {
    return this.post('/log/append', { project, entry });
  }

  // Capture Operations

  async captureStop(project, hookData) {
    return this.post('/capture/stop', { project, hookData });
  }

  async flushLog(project = null) {
    return this.post('/log/flush', { project });
  }

  // Summarization Operations

  async triggerSummarize(project, force = false) {
    return this.post('/summarize/trigger', { project, force });
  }

  async getSummarizeStatus(project) {
    return this.post('/summarize/status', { project });
  }

  async getSummary(project) {
    return this.post('/summary/get', { project });
  }
}

/**
 * Get a connected client (auto-starts server if needed)
 */
export async function getClient() {
  const { host, port } = await ensureServer();
  return new MnemeClient(host, port);
}
