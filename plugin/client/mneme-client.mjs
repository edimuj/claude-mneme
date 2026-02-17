/**
 * Mneme Client
 *
 * Thin HTTP client for hooks to communicate with the Mneme server.
 * Handles auto-start of server if not running.
 */

import { request } from 'http';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MEMORY_BASE = join(homedir(), '.claude-mneme');
const PID_FILE = join(MEMORY_BASE, '.server.pid');
const SERVER_SCRIPT = join(__dirname, '../server/mneme-server.mjs');

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
      // Missing serverScript means pre-upgrade server — also a mismatch
      if (pidData.serverScript !== SERVER_SCRIPT) {
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
          return { host, port };
        }
      } catch {
        // Not ready yet, continue waiting
      }
    }
  }

  throw new Error('Server failed to start within 3 seconds');
}

/**
 * HTTP client for the Mneme server
 */
export class MnemeClient {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.timeout = 2000; // 2 second timeout
  }

  /**
   * Make HTTP request to server
   */
  async request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        host: this.host,
        port: this.port,
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

  // Session Management

  async registerSession(sessionId, cwd) {
    return this.post('/session/register', { sessionId, cwd });
  }

  async unregisterSession(sessionId) {
    return this.post('/session/unregister', { sessionId });
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
