#!/usr/bin/env node
/**
 * Mneme Server
 *
 * Centralized daemon for managing Claude Mneme operations across multiple sessions.
 * Handles log batching, summarization throttling, entity extraction, and caching.
 */

import { createServer } from 'http';
import { existsSync, writeFileSync, unlinkSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { LogService } from './log-service.mjs';
import { SummarizationService } from './summarization-service.mjs';
import { EntityService } from './entity-service.mjs';

const MEMORY_BASE = join(homedir(), '.claude-mneme');
const PID_FILE = join(MEMORY_BASE, '.server.pid');
const LOG_FILE = join(MEMORY_BASE, '.server.log');
const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  inactivityTimeout: 15 * 60 * 1000, // 15 minutes
  batching: {
    log: { maxSize: 100, maxWaitMs: 1000 }
  },
  throttling: {
    summarize: { maxConcurrent: 1, cooldownMs: 30000 }
  },
  cache: {
    maxSize: 100,
    ttlMs: 5 * 60 * 1000
  },
  summarization: {
    entryThreshold: 50
  }
};

class Logger {
  constructor(logFile) {
    this.logFile = logFile;
  }

  log(level, event, data = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...data
    };
    const line = JSON.stringify(entry) + '\n';

    // Write to stderr for systemd/process managers
    process.stderr.write(line);

    // Append to log file (best effort)
    try {
      appendFileSync(this.logFile, line);
    } catch (e) {
      // Ignore log file write failures
    }
  }

  info(event, data) { this.log('info', event, data); }
  warn(event, data) { this.log('warn', event, data); }
  error(event, data) { this.log('error', event, data); }
  debug(event, data) { this.log('debug', event, data); }
}

class MnemeServer {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new Logger(LOG_FILE);
    this.server = null;
    this.port = null;
    this.sessions = new Set();
    this.lastActivity = Date.now();
    this.inactivityTimer = null;
    this.stats = {
      requestsHandled: 0,
      errorsTotal: 0,
      startedAt: new Date().toISOString()
    };

    // Initialize services
    this.summarizationService = new SummarizationService(
      this.config,
      this.logger,
      (project) => this.getProjectMemoryDir(project)
    );
    this.entityService = new EntityService(
      this.config,
      this.logger,
      (project) => this.getProjectMemoryDir(project)
    );
    this.logService = new LogService(this.config, this.logger, {
      onEntriesWritten: (project, entries) => {
        // Entity extraction (server is single writer — no lock needed)
        this.entityService.processEntries(project, entries);
        // Cache invalidation
        this.invalidateProjectCache(project);
        // Summarization check (fire-and-forget)
        this.summarizationService.trigger(project, false).catch(() => {});
      }
    });
  }

  /**
   * Get project memory directory path
   */
  getProjectMemoryDir(project) {
    const safeName = project.replace(/^\//, '-').replace(/\//g, '-');
    return join(MEMORY_BASE, 'projects', safeName);
  }

  /**
   * Invalidate project cache — writes {} to .cache.json
   */
  invalidateProjectCache(project) {
    try {
      const projectDir = this.getProjectMemoryDir(project);
      const cachePath = join(projectDir, '.cache.json');
      if (!existsSync(projectDir)) {
        mkdirSync(projectDir, { recursive: true });
      }
      writeFileSync(cachePath, '{}');
    } catch (err) {
      this.logger.error('cache-invalidation-failed', {
        project, error: err.message
      });
    }
  }

  async start() {
    // Clean up stale PID file
    if (existsSync(PID_FILE)) {
      try {
        const { pid } = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
        try {
          process.kill(pid, 0); // Check if process exists
          this.logger.warn('server-start-aborted', {
            reason: 'server-already-running',
            pid
          });
          process.exit(1);
        } catch {
          // Process dead, clean up
          unlinkSync(PID_FILE);
        }
      } catch (e) {
        unlinkSync(PID_FILE);
      }
    }

    // Create HTTP server
    this.server = createServer(this.handleRequest.bind(this));

    // Listen on random available port (localhost only)
    await new Promise((resolve, reject) => {
      this.server.listen(0, this.config.host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.port = this.server.address().port;

    // Write PID file (includes script path for version-mismatch detection)
    writeFileSync(PID_FILE, JSON.stringify({
      pid: process.pid,
      port: this.port,
      host: this.config.host,
      startedAt: this.stats.startedAt,
      serverScript: fileURLToPath(import.meta.url)
    }));

    // Start inactivity monitor
    this.startInactivityMonitor();

    this.logger.info('server-started', {
      port: this.port,
      host: this.config.host,
      pid: process.pid
    });
  }

  handleRequest(req, res) {
    this.lastActivity = Date.now();
    this.stats.requestsHandled++;

    // Parse URL
    const url = new URL(req.url, `http://${req.headers.host}`);

    // CORS headers (localhost only, but still good practice)
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle OPTIONS (preflight)
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route request
    this.route(req, res, url).catch(err => {
      this.stats.errorsTotal++;
      this.logger.error('request-error', {
        method: req.method,
        url: url.pathname,
        error: err.message,
        stack: err.stack
      });

      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'internal-server-error',
          message: err.message
        }));
      }
    });
  }

  async route(req, res, url) {
    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      return this.handleHealth(req, res);
    }

    // Session management
    if (req.method === 'POST' && url.pathname === '/session/register') {
      return this.handleSessionRegister(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/session/unregister') {
      return this.handleSessionUnregister(req, res);
    }

    // Log operations
    if (req.method === 'POST' && url.pathname === '/log/append') {
      return this.handleLogAppend(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/log/flush') {
      return this.handleLogFlush(req, res);
    }

    // Summarization operations
    if (req.method === 'POST' && url.pathname === '/summarize/trigger') {
      return this.handleSummarizeTrigger(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/summarize/status') {
      return this.handleSummarizeStatus(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/summary/get') {
      return this.handleSummaryGet(req, res);
    }

    // Not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: 'not-found',
      path: url.pathname
    }));
  }

  async handleHealth(req, res) {
    const uptime = Date.now() - new Date(this.stats.startedAt).getTime();
    const logStats = this.logService.getStats();
    const sumStats = this.summarizationService.getStats();

    const response = {
      ok: true,
      uptime,
      activeSessions: this.sessions.size,
      queueDepth: {
        log: this.logService.queueDepth(),
        summarize: sumStats.runningCount
      },
      cache: {
        hitRate: sumStats.cacheStats.hitRate,
        size: sumStats.cacheStats.size,
        maxSize: sumStats.cacheStats.maxSize
      },
      stats: {
        requestsHandled: this.stats.requestsHandled,
        errorsTotal: this.stats.errorsTotal,
        log: {
          entriesReceived: logStats.entriesReceived,
          entriesDeduplicated: logStats.entriesDeduplicated,
          entriesWritten: logStats.entriesWritten,
          batchesFlushed: logStats.batchesFlushed
        },
        summarization: {
          started: sumStats.summarizationsStarted,
          completed: sumStats.summarizationsCompleted,
          failed: sumStats.summarizationsFailed,
          throttled: sumStats.throttled
        },
        entity: this.entityService.getStats()
      }
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  async handleSessionRegister(req, res) {
    const body = await this.readBody(req);
    const { sessionId, cwd } = body;

    if (!sessionId || !cwd) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'missing-fields',
        required: ['sessionId', 'cwd']
      }));
      return;
    }

    this.sessions.add(sessionId);
    this.logger.info('session-registered', { sessionId, cwd, total: this.sessions.size });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  async handleSessionUnregister(req, res) {
    const body = await this.readBody(req);
    const { sessionId } = body;

    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'missing-sessionId'
      }));
      return;
    }

    this.sessions.delete(sessionId);
    this.logger.info('session-unregistered', { sessionId, total: this.sessions.size });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  async handleLogAppend(req, res) {
    const body = await this.readBody(req);
    const { project, entry } = body;

    if (!project || !entry) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'missing-fields',
        required: ['project', 'entry']
      }));
      return;
    }

    const result = this.logService.append(project, entry);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  async handleLogFlush(req, res) {
    const body = await this.readBody(req);
    const { project } = body;

    const result = await this.logService.flush(project);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  async handleSummarizeTrigger(req, res) {
    const body = await this.readBody(req);
    const { project, force = false } = body;

    if (!project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'missing-project'
      }));
      return;
    }

    const result = await this.summarizationService.trigger(project, force);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  async handleSummarizeStatus(req, res) {
    const body = await this.readBody(req);
    const { project } = body;

    if (!project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'missing-project'
      }));
      return;
    }

    const status = this.summarizationService.getStatus(project);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  }

  async handleSummaryGet(req, res) {
    const body = await this.readBody(req);
    const { project } = body;

    if (!project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'missing-project'
      }));
      return;
    }

    const result = this.summarizationService.getSummary(project);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  async readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        // Prevent huge payloads
        if (body.length > 1e6) {
          req.destroy();
          reject(new Error('payload-too-large'));
        }
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('invalid-json'));
        }
      });
      req.on('error', reject);
    });
  }

  startInactivityMonitor() {
    this.inactivityTimer = setInterval(() => {
      const inactive = Date.now() - this.lastActivity;

      // Only shutdown if no active sessions and inactive
      if (this.sessions.size === 0 && inactive > this.config.inactivityTimeout) {
        this.logger.info('server-shutdown', {
          reason: 'inactivity',
          inactiveMs: inactive
        });
        this.shutdown();
      }
    }, 60000); // Check every minute
  }

  async shutdown() {
    if (this.inactivityTimer) {
      clearInterval(this.inactivityTimer);
    }

    // Shutdown services (flush pending operations)
    await this.logService.shutdown();
    await this.summarizationService.shutdown();

    if (this.server) {
      this.server.close();
    }

    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }

    this.logger.info('server-stopped', {
      uptime: Date.now() - new Date(this.stats.startedAt).getTime()
    });

    process.exit(0);
  }
}

// Graceful shutdown handlers
function setupShutdownHandlers(server) {
  const shutdown = () => server.shutdown();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', shutdown);
}

// Main
async function main() {
  const server = new MnemeServer();
  setupShutdownHandlers(server);
  await server.start();
}

main().catch(err => {
  console.error('[mneme-server] Fatal error:', err);
  process.exit(1);
});
