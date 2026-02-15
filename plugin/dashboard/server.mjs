#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_BASE = join(homedir(), '.claude-mneme');
const PROJECTS_DIR = join(MEMORY_BASE, 'projects');
const SERVICE_PID_FILE = join(MEMORY_BASE, '.server.pid');
const DASHBOARD_PID_FILE = join(MEMORY_BASE, '.dashboard.pid');

// --- Config ---

function loadDashboardConfig() {
  try {
    const raw = JSON.parse(readFileSync(join(MEMORY_BASE, 'config.json'), 'utf-8'));
    return {
      port: raw.dashboard?.port ?? 3848,
      host: raw.dashboard?.host ?? '127.0.0.1',
    };
  } catch {
    return { port: 3848, host: '127.0.0.1' };
  }
}

// CLI args override config
function resolveArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

const config = loadDashboardConfig();
const port = (() => {
  const arg = resolveArg('port');
  if (arg) {
    const p = parseInt(arg, 10);
    if (p > 0 && p < 65536) return p;
  }
  return config.port;
})();
const host = resolveArg('host') ?? config.host;

// --- Daemon mode ---

if (process.argv.includes('--daemon')) {
  const args = [fileURLToPath(import.meta.url), '--port', String(port), '--host', host];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  // Give it a moment to bind or fail
  setTimeout(() => {
    try {
      process.kill(child.pid, 0);
      const url = host === '0.0.0.0'
        ? `http://localhost:${port}`
        : `http://${host}:${port}`;
      console.log(`Dashboard started in background (PID ${child.pid}): ${url}`);
    } catch {
      console.error('Dashboard failed to start');
      process.exit(1);
    }
    process.exit(0);
  }, 300);
} else {
  // --- Foreground mode: start server directly ---
  startServer();
}

// --- Helpers ---

function readJsonSafe(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return fallback; }
}

function readJsonlSafe(path, fallback = []) {
  try {
    if (!existsSync(path)) return fallback;
    const content = readFileSync(path, 'utf-8').trim();
    if (!content) return fallback;
    return content.split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return fallback; }
}

function readTextSafe(path, fallback = '') {
  try {
    if (!existsSync(path)) return fallback;
    return readFileSync(path, 'utf-8');
  } catch { return fallback; }
}

function displayName(dirName) {
  const parts = dirName.replace(/^-/, '').split('-');
  const projIdx = parts.lastIndexOf('projects');
  if (projIdx >= 0 && projIdx < parts.length - 1) {
    return parts.slice(projIdx + 1).join('-');
  }
  return dirName;
}

function isValidProjectName(name) {
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  const projectDir = join(PROJECTS_DIR, name);
  return existsSync(projectDir) && statSync(projectDir).isDirectory();
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res, content) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(content);
}

function send404(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// --- PID file management ---

function writePidFile() {
  const data = {
    pid: process.pid,
    port,
    host,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(DASHBOARD_PID_FILE, JSON.stringify(data) + '\n');
}

function removePidFile() {
  try { unlinkSync(DASHBOARD_PID_FILE); } catch { /* already gone */ }
}

// --- API Handlers ---

function getProjects() {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR)
    .filter(name => {
      const full = join(PROJECTS_DIR, name);
      return statSync(full).isDirectory();
    })
    .map(name => ({
      name,
      displayName: displayName(name),
      hasLog: existsSync(join(PROJECTS_DIR, name, 'log.jsonl')),
      hasSummary: existsSync(join(PROJECTS_DIR, name, 'summary.json')),
      hasEntities: existsSync(join(PROJECTS_DIR, name, 'entities.json')),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function getProjectData(name) {
  if (!isValidProjectName(name)) return null;
  const dir = join(PROJECTS_DIR, name);

  const log = readJsonlSafe(join(dir, 'log.jsonl'));
  const summary = readJsonSafe(join(dir, 'summary.json'));
  const summaryMd = readTextSafe(join(dir, 'summary.md'));
  const entities = readJsonSafe(join(dir, 'entities.json'), {});
  const remembered = readJsonSafe(join(dir, 'remembered.json'), []);
  const handoff = readJsonSafe(join(dir, 'handoff.json'));

  const logTypes = {};
  for (const entry of log) {
    logTypes[entry.type] = (logTypes[entry.type] || 0) + 1;
  }
  const lastActivity = log.length > 0 ? log[log.length - 1].ts : null;
  const entityCount = Object.values(entities).reduce((sum, cat) => {
    return sum + (typeof cat === 'object' && cat !== null ? Object.keys(cat).length : 0);
  }, 0);

  return {
    name,
    displayName: displayName(name),
    stats: {
      logEntries: log.length,
      logTypes,
      entityCount,
      rememberedCount: remembered.length,
      lastActivity,
    },
    log,
    summary,
    summaryMd,
    entities,
    remembered,
    handoff,
  };
}

function getErrors() {
  const errorLogPath = join(MEMORY_BASE, 'errors.log');
  const content = readTextSafe(errorLogPath);
  if (!content.trim()) return [];

  const lines = content.trim().split('\n');
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip bad lines */ }
  }
  return entries.slice(-100);
}

function getConfig() {
  return readJsonSafe(join(MEMORY_BASE, 'config.json'), {});
}

function getServiceStatus() {
  try {
    if (!existsSync(SERVICE_PID_FILE)) return { running: false };
    const data = JSON.parse(readFileSync(SERVICE_PID_FILE, 'utf-8'));
    process.kill(data.pid, 0);
    return { running: true, ...data };
  } catch {
    return { running: false };
  }
}

// --- Router ---

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Static: serve index.html
  if (path === '/' || path === '/index.html') {
    try {
      const html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
      sendHtml(res, html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load index.html');
    }
    return;
  }

  // Health endpoint
  if (path === '/api/health') {
    sendJson(res, { status: 'ok', pid: process.pid, uptime: process.uptime() });
    return;
  }

  // API routes
  if (path === '/api/projects') {
    sendJson(res, getProjects());
    return;
  }

  const projectMatch = path.match(/^\/api\/projects\/(.+)$/);
  if (projectMatch) {
    const projectName = decodeURIComponent(projectMatch[1]);
    const data = getProjectData(projectName);
    if (!data) {
      sendJson(res, { error: 'Project not found' }, 404);
      return;
    }
    sendJson(res, data);
    return;
  }

  if (path === '/api/errors') {
    sendJson(res, getErrors());
    return;
  }

  if (path === '/api/config') {
    sendJson(res, getConfig());
    return;
  }

  if (path === '/api/service-status') {
    sendJson(res, getServiceStatus());
    return;
  }

  send404(res);
}

// --- Start ---

function startServer() {
  const server = createServer(handleRequest);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, host, () => {
    const displayHost = host === '0.0.0.0' ? 'all interfaces' : host;
    const accessUrl = host === '0.0.0.0'
      ? `http://localhost:${port}`
      : `http://${host}:${port}`;
    console.log(`Mneme Dashboard running at ${accessUrl} (${displayHost})`);
    writePidFile();
  });

  function shutdown() {
    removePidFile();
    server.close(() => process.exit(0));
    // Force exit after 2s if connections linger
    setTimeout(() => process.exit(0), 2000);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('exit', removePidFile);
}
