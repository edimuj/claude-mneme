#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';

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

function getLanIp() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

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
        ? `http://${getLanIp()}:${port}`
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
  // Home directory: -home-username or -Users-username (no deeper path)
  const homePath = homedir().replace(/^\//, '-').replace(/\//g, '-');
  if (dirName === homePath) return '~ (home)';

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

// --- Mutation Helpers ---

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function withFileLock(lockPath, fn, staleSec = 10) {
  // Check for stale lock
  if (existsSync(lockPath)) {
    try {
      const lockTime = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
      if (lockTime && Date.now() - lockTime < staleSec * 1000) {
        throw new Error('Resource is locked');
      }
    } catch (e) {
      if (e.message === 'Resource is locked') throw e;
    }
  }
  writeFileSync(lockPath, Date.now().toString());
  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch {}
  }
}

function invalidateProjectCache(projectName) {
  const cachePath = join(PROJECTS_DIR, projectName, '.cache.json');
  try { writeFileSync(cachePath, '{}\n'); } catch {}
}

const MEM_SUMMARIZE_SCRIPT = join(__dirname, '..', 'scripts', 'mem-summarize.mjs');

async function handleSummarize(projectName) {
  const projectDir = join(PROJECTS_DIR, projectName);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = execFile(process.execPath, [MEM_SUMMARIZE_SCRIPT, '--force', '--project-dir', projectDir], {
      timeout: 120000,
    }, (err) => {
      invalidateProjectCache(projectName);
      if (err) {
        resolve({ status: 'error', message: err.message, stderr });
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ status: 'error', message: 'Could not parse output', stdout }); }
    });
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
  });
}

function handleDeleteRemembered(projectName, index) {
  const filePath = join(PROJECTS_DIR, projectName, 'remembered.json');
  return withFileLock(filePath + '.lock', () => {
    const items = readJsonSafe(filePath, []);
    if (index < 0 || index >= items.length) throw new Error(`Index ${index} out of range (${items.length} items)`);
    const removed = items.splice(index, 1)[0];
    writeFileSync(filePath, JSON.stringify(items, null, 2) + '\n');
    invalidateProjectCache(projectName);
    return { status: 'ok', removed };
  });
}

function handleDeleteEntity(projectName, category, entity) {
  const filePath = join(PROJECTS_DIR, projectName, 'entities.json');
  return withFileLock(filePath + '.lock', () => {
    const data = readJsonSafe(filePath, {});
    if (!data[category] || !data[category][entity]) throw new Error(`Entity "${entity}" not found in "${category}"`);
    const removed = data[category][entity];
    delete data[category][entity];
    if (Object.keys(data[category]).length === 0) delete data[category];
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    invalidateProjectCache(projectName);
    return { status: 'ok', removed };
  });
}

function handleDeleteLog(projectName, index) {
  const filePath = join(PROJECTS_DIR, projectName, 'log.jsonl');
  return withFileLock(filePath + '.wlock', () => {
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(l => l);
    if (index < 0 || index >= lines.length) throw new Error(`Index ${index} out of range (${lines.length} entries)`);
    const removed = JSON.parse(lines[index]);
    lines.splice(index, 1);
    writeFileSync(filePath, lines.length > 0 ? lines.join('\n') + '\n' : '');
    invalidateProjectCache(projectName);
    return { status: 'ok', removed };
  });
}

// --- Router ---

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET' && req.method !== 'POST') {
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
  if (path === '/api/projects' && req.method === 'GET') {
    sendJson(res, getProjects());
    return;
  }

  // POST mutation routes: /api/projects/:name/<action>
  const mutationMatch = path.match(/^\/api\/projects\/([^/]+)\/(summarize|remembered\/delete|entities\/delete|log\/delete)$/);
  if (mutationMatch && req.method === 'POST') {
    const projectName = decodeURIComponent(mutationMatch[1]);
    const action = mutationMatch[2];
    if (!isValidProjectName(projectName)) {
      sendJson(res, { error: 'Project not found' }, 404);
      return;
    }
    try {
      const body = await readBody(req);
      let result;
      switch (action) {
        case 'summarize':
          result = await handleSummarize(projectName);
          break;
        case 'remembered/delete':
          result = handleDeleteRemembered(projectName, body.index);
          break;
        case 'entities/delete':
          result = handleDeleteEntity(projectName, body.category, body.entity);
          break;
        case 'log/delete':
          result = handleDeleteLog(projectName, body.index);
          break;
      }
      sendJson(res, result);
    } catch (err) {
      sendJson(res, { error: err.message }, 400);
    }
    return;
  }

  // GET project data: /api/projects/:name
  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && req.method === 'GET') {
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
      ? `http://${getLanIp()}:${port}`
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
