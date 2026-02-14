#!/usr/bin/env node

import { createServer } from 'http';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_BASE = join(homedir(), '.claude-mneme');
const PROJECTS_DIR = join(MEMORY_BASE, 'projects');
const PID_FILE = join(MEMORY_BASE, '.server.pid');
const DEFAULT_PORT = 3848;

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
  // "-home-edimuj-projects-claude-mneme" → "claude-mneme"
  const parts = dirName.replace(/^-/, '').split('-');
  // Find last meaningful segment (after "projects" or similar)
  const projIdx = parts.lastIndexOf('projects');
  if (projIdx >= 0 && projIdx < parts.length - 1) {
    return parts.slice(projIdx + 1).join('-');
  }
  // Fallback: last segment or full name
  return dirName;
}

function isValidProjectName(name) {
  // Prevent path traversal
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

  // Compute stats
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
    if (!existsSync(PID_FILE)) return { running: false };
    const data = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
    // Check if process is actually running
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

  // CORS not needed (same-origin only), but add security headers
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

const port = (() => {
  const idx = process.argv.indexOf('--port');
  if (idx >= 0 && process.argv[idx + 1]) {
    const p = parseInt(process.argv[idx + 1], 10);
    if (p > 0 && p < 65536) return p;
  }
  return DEFAULT_PORT;
})();

const server = createServer(handleRequest);
server.listen(port, '127.0.0.1', () => {
  console.log(`Mneme Dashboard running at http://127.0.0.1:${port}`);
});
