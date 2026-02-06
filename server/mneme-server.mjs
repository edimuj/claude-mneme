#!/usr/bin/env node
/**
 * Mneme Sync Server
 *
 * Zero-dependency Node.js server for syncing claude-mneme memory across machines.
 * Uses only built-in Node.js modules (http, fs, path, os, crypto).
 *
 * Features:
 * - Lock-based concurrency (one machine at a time per project)
 * - File storage and retrieval
 * - Optional API key authentication
 * - Heartbeat-based lock extension
 */

import { createServer } from 'http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, openSync, closeSync, writeSync, constants as fsConstants } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { randomUUID, timingSafeEqual } from 'crypto';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CONFIG = {
  port: 3847,
  dataDir: join(homedir(), '.mneme-server'),
  apiKeys: [],           // Empty = no auth required
  lockTTLMinutes: 30,
  allowedOrigins: []     // Empty = no CORS (CLI-only); set to ['*'] to allow all
};

function loadConfig() {
  const configPath = join(homedir(), '.mneme-server', 'config.json');
  let config = { ...DEFAULT_CONFIG };

  if (existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      config = { ...config, ...userConfig };
    } catch (err) {
      console.error(`[mneme-server] Error reading config: ${err.message}`);
    }
  }

  // Expand ~ in dataDir
  if (config.dataDir.startsWith('~')) {
    config.dataDir = config.dataDir.replace('~', homedir());
  }

  return config;
}

const config = loadConfig();

// Ensure data directory exists
if (!existsSync(config.dataDir)) {
  mkdirSync(config.dataDir, { recursive: true });
}

// ============================================================================
// Utilities
// ============================================================================

function getProjectDir(projectId) {
  // Sanitize project ID for filesystem
  const safeName = projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = join(config.dataDir, 'projects', safeName);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getLockPath(projectId) {
  return join(getProjectDir(projectId), '.lock.json');
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

// ============================================================================
// Rate Limiting
// ============================================================================

const rateLimitState = new Map(); // clientIP -> { count, windowStart }
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = config.rateLimitPerMinute || 120;

function checkRateLimit(req, res) {
  const clientIP = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let state = rateLimitState.get(clientIP);

  if (!state || now - state.windowStart > RATE_LIMIT_WINDOW_MS) {
    state = { count: 0, windowStart: now };
    rateLimitState.set(clientIP, state);
  }

  state.count++;

  if (state.count > RATE_LIMIT_MAX_REQUESTS) {
    sendError(res, 429, 'Too many requests');
    return false;
  }

  return true;
}

// Periodically clean up stale rate limit entries (every 5 minutes)
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [ip, state] of rateLimitState) {
    if (state.windowStart < cutoff) rateLimitState.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({ raw: body });
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// ============================================================================
// Authentication
// ============================================================================

function checkAuth(req, res) {
  if (config.apiKeys.length === 0) {
    return true; // No auth required
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(res, 401, 'Missing or invalid Authorization header');
    return false;
  }

  const token = authHeader.slice(7);
  const tokenBuf = Buffer.from(token);
  const isValid = config.apiKeys.some(key => {
    const keyBuf = Buffer.from(key);
    if (tokenBuf.length !== keyBuf.length) return false;
    return timingSafeEqual(tokenBuf, keyBuf);
  });

  if (!isValid) {
    sendError(res, 403, 'Invalid API key');
    return false;
  }

  return true;
}

// ============================================================================
// Lock Management
// ============================================================================

function getLock(projectId) {
  const lockPath = getLockPath(projectId);
  if (!existsSync(lockPath)) {
    return null;
  }

  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));

    // Check if lock has expired
    if (new Date(lock.expiresAt) < new Date()) {
      // Lock expired, remove it
      unlinkSync(lockPath);
      return null;
    }

    return lock;
  } catch {
    return null;
  }
}

function acquireLock(projectId, clientId) {
  const existingLock = getLock(projectId);

  // If lock is held by a different client, deny
  if (existingLock && existingLock.clientId !== clientId) {
    return { success: false, lock: existingLock };
  }

  const lockPath = getLockPath(projectId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.lockTTLMinutes * 60 * 1000);

  const lock = {
    clientId,
    acquiredAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  };

  const lockJson = JSON.stringify(lock, null, 2);

  if (existingLock) {
    // Re-acquiring own lock (extend) — safe to overwrite
    writeFileSync(lockPath, lockJson);
  } else {
    // New lock — use atomic create to prevent race with another request
    try {
      const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
      writeSync(fd, Buffer.from(lockJson));
      closeSync(fd);
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Another request won the race — re-read and report conflict
        const raceLock = getLock(projectId);
        return { success: false, lock: raceLock };
      }
      throw err;
    }
  }

  return { success: true, lock };
}

function releaseLock(projectId, clientId) {
  const existingLock = getLock(projectId);

  if (!existingLock) {
    return { success: true, message: 'No lock to release' };
  }

  if (existingLock.clientId !== clientId) {
    return { success: false, message: 'Lock held by different client' };
  }

  unlinkSync(getLockPath(projectId));
  return { success: true };
}

function heartbeatLock(projectId, clientId) {
  const existingLock = getLock(projectId);

  if (!existingLock) {
    return { success: false, message: 'No lock to extend' };
  }

  if (existingLock.clientId !== clientId) {
    return { success: false, message: 'Lock held by different client' };
  }

  // Extend the lock
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.lockTTLMinutes * 60 * 1000);

  existingLock.expiresAt = expiresAt.toISOString();
  writeFileSync(getLockPath(projectId), JSON.stringify(existingLock, null, 2));

  return { success: true, lock: existingLock };
}

// ============================================================================
// File Operations
// ============================================================================

// Files that should be synced
const SYNCABLE_FILES = [
  'log.jsonl',
  'summary.json',
  'remembered.json',
  'entities.json'
];

function listFiles(projectId) {
  const dir = getProjectDir(projectId);
  const files = [];

  for (const name of SYNCABLE_FILES) {
    const filePath = join(dir, name);
    if (existsSync(filePath)) {
      const stat = statSync(filePath);
      files.push({
        name,
        size: stat.size,
        mtime: stat.mtime.toISOString()
      });
    }
  }

  return files;
}

function getFile(projectId, fileName) {
  // Only allow syncing specific files
  if (!SYNCABLE_FILES.includes(fileName)) {
    return { error: 'File not allowed for sync' };
  }

  const filePath = join(getProjectDir(projectId), fileName);

  if (!existsSync(filePath)) {
    return { error: 'File not found' };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const stat = statSync(filePath);
    return {
      content,
      mtime: stat.mtime.toISOString()
    };
  } catch (err) {
    return { error: err.message };
  }
}

function putFile(projectId, fileName, content, clientId) {
  // Only allow syncing specific files
  if (!SYNCABLE_FILES.includes(fileName)) {
    return { error: 'File not allowed for sync' };
  }

  // Verify lock
  const lock = getLock(projectId);
  if (!lock) {
    return { error: 'No lock held - acquire lock before writing' };
  }
  if (lock.clientId !== clientId) {
    return { error: 'Lock held by different client' };
  }

  const filePath = join(getProjectDir(projectId), fileName);

  try {
    writeFileSync(filePath, content);
    const stat = statSync(filePath);
    return {
      success: true,
      mtime: stat.mtime.toISOString()
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ============================================================================
// Request Router
// ============================================================================

function parseRoute(url) {
  // Remove query string
  const path = url.split('?')[0];

  // Match /projects/:id/...
  const match = path.match(/^\/projects\/([^/]+)(\/.*)?$/);
  if (!match) {
    return null;
  }

  return {
    projectId: decodeURIComponent(match[1]),
    subPath: match[2] || ''
  };
}

async function handleRequest(req, res) {
  // CORS headers — only set if allowedOrigins is configured
  const origin = req.headers['origin'];
  if (config.allowedOrigins.length > 0 && origin) {
    const allowed = config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', config.allowedOrigins.includes('*') ? '*' : origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Id');
    }
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Rate limiting
  if (!checkRateLimit(req, res)) {
    return;
  }

  // Health check
  if (req.url === '/health' || req.url === '/') {
    sendJson(res, 200, {
      status: 'ok',
      version: '1.0.0',
      authRequired: config.apiKeys.length > 0
    });
    return;
  }

  // Check authentication
  if (!checkAuth(req, res)) {
    return;
  }

  // Parse route
  const route = parseRoute(req.url);
  if (!route) {
    sendError(res, 404, 'Not found');
    return;
  }

  const { projectId, subPath } = route;
  const clientId = req.headers['x-client-id'];

  try {
    // Lock endpoints
    if (subPath === '/lock') {
      if (req.method === 'POST') {
        // Acquire lock
        if (!clientId) {
          sendError(res, 400, 'X-Client-Id header required');
          return;
        }
        const result = acquireLock(projectId, clientId);
        if (result.success) {
          sendJson(res, 200, result);
        } else {
          sendJson(res, 409, { error: 'Lock held by another client', lock: result.lock });
        }
        return;
      }

      if (req.method === 'DELETE') {
        // Release lock
        if (!clientId) {
          sendError(res, 400, 'X-Client-Id header required');
          return;
        }
        const result = releaseLock(projectId, clientId);
        if (result.success) {
          sendJson(res, 200, result);
        } else {
          sendError(res, 403, result.message);
        }
        return;
      }

      if (req.method === 'GET') {
        // Get lock status
        const lock = getLock(projectId);
        sendJson(res, 200, { locked: !!lock, lock });
        return;
      }
    }

    if (subPath === '/lock/heartbeat') {
      if (req.method === 'POST') {
        if (!clientId) {
          sendError(res, 400, 'X-Client-Id header required');
          return;
        }
        const result = heartbeatLock(projectId, clientId);
        if (result.success) {
          sendJson(res, 200, result);
        } else {
          sendError(res, 403, result.message);
        }
        return;
      }
    }

    // File list
    if (subPath === '/files') {
      if (req.method === 'GET') {
        const files = listFiles(projectId);
        sendJson(res, 200, { files });
        return;
      }
    }

    // Single file operations
    const fileMatch = subPath.match(/^\/files\/([^/]+)$/);
    if (fileMatch) {
      const fileName = decodeURIComponent(fileMatch[1]);

      if (req.method === 'GET') {
        const result = getFile(projectId, fileName);
        if (result.error) {
          sendError(res, result.error === 'File not found' ? 404 : 400, result.error);
        } else {
          sendJson(res, 200, result);
        }
        return;
      }

      if (req.method === 'PUT') {
        if (!clientId) {
          sendError(res, 400, 'X-Client-Id header required');
          return;
        }
        const body = await parseBody(req);
        const content = body.content || body.raw || '';
        const result = putFile(projectId, fileName, content, clientId);
        if (result.error) {
          sendError(res, 403, result.error);
        } else {
          sendJson(res, 200, result);
        }
        return;
      }
    }

    sendError(res, 404, 'Not found');

  } catch (err) {
    console.error(`[mneme-server] Error handling request: ${err.message}`);
    sendError(res, 500, 'Internal server error');
  }
}

// ============================================================================
// Server Startup
// ============================================================================

const server = createServer(handleRequest);

server.listen(config.port, () => {
  console.log(`[mneme-server] Started on port ${config.port}`);
  console.log(`[mneme-server] Data directory: ${config.dataDir}`);
  console.log(`[mneme-server] Auth required: ${config.apiKeys.length > 0}`);
  console.log(`[mneme-server] Lock TTL: ${config.lockTTLMinutes} minutes`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[mneme-server] Shutting down...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[mneme-server] Shutting down...');
  server.close(() => {
    process.exit(0);
  });
});
