/**
 * Sync Client for claude-mneme
 *
 * Handles synchronization with the optional mneme-server.
 * All operations fail gracefully to local-only mode.
 */

import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import http from 'http';
import https from 'https';
import { ensureMemoryDirs, getProjectName } from './utils.mjs';

// ============================================================================
// Client ID Management
// ============================================================================

/**
 * Get or create a persistent client ID for this machine.
 * Stored in ~/.claude-mneme/.client-id
 */
function getClientId(basePath) {
  const clientIdPath = join(basePath, '.client-id');

  if (existsSync(clientIdPath)) {
    try {
      return readFileSync(clientIdPath, 'utf-8').trim();
    } catch {
      // Fall through to generate new ID
    }
  }

  // Generate new client ID: hostname + random UUID
  const clientId = `${hostname()}-${randomUUID().slice(0, 8)}`;
  try {
    writeFileSync(clientIdPath, clientId);
  } catch {
    // Ignore write errors, use generated ID
  }

  return clientId;
}

// ============================================================================
// HTTP Client
// ============================================================================

/**
 * Simple HTTP client using Node.js built-in http/https modules
 */
class HttpClient {
  constructor(baseUrl, apiKey = null, timeoutMs = 10000) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;

    // Determine protocol
    const url = new URL(baseUrl);
    this.protocol = url.protocol === 'https:' ? 'https' : 'http';
  }

  async request(method, path, body = null, headers = {}) {
    const url = new URL(path, this.baseUrl);

    // Add auth header if API key is set
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // Add content type for bodies
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    return new Promise((resolve, reject) => {
      const httpModule = this.protocol === 'https' ? https : http;

      const options = {
        method,
        hostname: url.hostname,
        port: url.port || (this.protocol === 'https' ? 443 : 80),
        path: url.pathname + url.search,
        headers,
        timeout: this.timeoutMs
      };

      const req = httpModule.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          let data = null;
          try {
            data = JSON.parse(body);
          } catch {
            data = { raw: body };
          }
          resolve({
            status: res.statusCode,
            data
          });
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

  get(path, headers = {}) {
    return this.request('GET', path, null, headers);
  }

  post(path, body = null, headers = {}) {
    return this.request('POST', path, body, headers);
  }

  put(path, body, headers = {}) {
    return this.request('PUT', path, body, headers);
  }

  delete(path, headers = {}) {
    return this.request('DELETE', path, null, headers);
  }
}

// ============================================================================
// Sync Client
// ============================================================================

/**
 * SyncClient handles all communication with the mneme-server
 */
export class SyncClient {
  constructor(config, cwd) {
    const syncConfig = config.sync || {};

    this.enabled = syncConfig.enabled === true && !!syncConfig.serverUrl;
    this.serverUrl = syncConfig.serverUrl;
    this.apiKey = syncConfig.apiKey || null;
    this.timeoutMs = syncConfig.timeoutMs || 10000;
    this.retries = syncConfig.retries || 3;

    this.cwd = cwd;
    this.paths = ensureMemoryDirs(cwd);
    this.projectId = syncConfig.projectId || getProjectName(cwd);
    this.clientId = getClientId(this.paths.base);

    this.http = this.enabled
      ? new HttpClient(this.serverUrl, this.apiKey, this.timeoutMs)
      : null;
  }

  /**
   * Check if sync is enabled and server is reachable
   */
  async checkHealth() {
    if (!this.enabled) {
      return { ok: false, reason: 'sync_disabled' };
    }

    try {
      const res = await this.http.get('/health');
      if (res.status === 200 && res.data.status === 'ok') {
        return { ok: true, authRequired: res.data.authRequired };
      }
      return { ok: false, reason: 'server_error', status: res.status };
    } catch (err) {
      return { ok: false, reason: 'unreachable', error: err.message };
    }
  }

  /**
   * Acquire lock for this project
   */
  async acquireLock() {
    if (!this.enabled) return { success: false, reason: 'sync_disabled' };

    try {
      const res = await this.http.post(
        `/projects/${encodeURIComponent(this.projectId)}/lock`,
        null,
        { 'X-Client-Id': this.clientId }
      );

      if (res.status === 200) {
        return { success: true, lock: res.data.lock };
      }

      if (res.status === 409) {
        return {
          success: false,
          reason: 'locked_by_other',
          lock: res.data.lock
        };
      }

      return { success: false, reason: 'server_error', status: res.status };
    } catch (err) {
      return { success: false, reason: 'unreachable', error: err.message };
    }
  }

  /**
   * Release lock for this project
   */
  async releaseLock() {
    if (!this.enabled) return { success: true };

    try {
      const res = await this.http.delete(
        `/projects/${encodeURIComponent(this.projectId)}/lock`,
        { 'X-Client-Id': this.clientId }
      );

      return { success: res.status === 200 };
    } catch {
      // Ignore errors on release - lock will expire
      return { success: true };
    }
  }

  /**
   * Send heartbeat to extend lock TTL
   */
  async heartbeat() {
    if (!this.enabled) return { success: false };

    try {
      const res = await this.http.post(
        `/projects/${encodeURIComponent(this.projectId)}/lock/heartbeat`,
        null,
        { 'X-Client-Id': this.clientId }
      );

      return { success: res.status === 200 };
    } catch {
      return { success: false };
    }
  }

  /**
   * List files on server with mtimes
   */
  async listServerFiles() {
    if (!this.enabled) return { success: false };

    try {
      const res = await this.http.get(
        `/projects/${encodeURIComponent(this.projectId)}/files`
      );

      if (res.status === 200) {
        return { success: true, files: res.data.files || [] };
      }
      return { success: false };
    } catch {
      return { success: false };
    }
  }

  /**
   * Download a file from server
   */
  async downloadFile(fileName) {
    if (!this.enabled) return { success: false };

    try {
      const res = await this.http.get(
        `/projects/${encodeURIComponent(this.projectId)}/files/${encodeURIComponent(fileName)}`
      );

      if (res.status === 200) {
        return {
          success: true,
          content: res.data.content,
          mtime: res.data.mtime
        };
      }
      return { success: false, status: res.status };
    } catch {
      return { success: false };
    }
  }

  /**
   * Upload a file to server
   */
  async uploadFile(fileName, content) {
    if (!this.enabled) return { success: false };

    try {
      const res = await this.http.put(
        `/projects/${encodeURIComponent(this.projectId)}/files/${encodeURIComponent(fileName)}`,
        { content },
        { 'X-Client-Id': this.clientId }
      );

      if (res.status === 200) {
        return { success: true, mtime: res.data.mtime };
      }
      return { success: false, error: res.data?.error };
    } catch {
      return { success: false };
    }
  }
}

// ============================================================================
// Files to Sync
// ============================================================================

const FILES_TO_SYNC = [
  { name: 'log.jsonl', key: 'log' },
  { name: 'summary.json', key: 'summaryJson' },
  { name: 'summary.md', key: 'summary' },
  { name: 'remembered.json', key: 'remembered' },
  { name: 'entities.json', key: 'entities' }
];

/**
 * Get local file info (mtime)
 */
function getLocalFileInfo(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const stat = statSync(filePath);
    return {
      mtime: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Heartbeat Management
// ============================================================================

let heartbeatInterval = null;
let heartbeatClient = null;

/**
 * Start heartbeat to keep lock alive
 */
export function startHeartbeat(cwd, config) {
  if (heartbeatInterval) {
    return; // Already running
  }

  const syncConfig = config.sync || {};
  if (!syncConfig.enabled || !syncConfig.serverUrl) {
    return;
  }

  heartbeatClient = new SyncClient(config, cwd);

  // Send heartbeat every 5 minutes (default lock TTL is 30 min)
  const intervalMs = 5 * 60 * 1000;

  heartbeatInterval = setInterval(async () => {
    const result = await heartbeatClient.heartbeat();
    if (!result.success) {
      // Lost lock - stop heartbeat
      console.error('[mneme-sync] Lost lock, stopping heartbeat');
      stopHeartbeat();
    }
  }, intervalMs);

  // Don't prevent process from exiting
  heartbeatInterval.unref();
}

/**
 * Stop heartbeat
 */
export function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  heartbeatClient = null;
}

// ============================================================================
// Pull / Push Operations
// ============================================================================

/**
 * Pull files from server at session start
 *
 * @param {string} cwd - Working directory
 * @param {object} config - Full config
 * @returns {object} { synced: boolean, lockAcquired: boolean, files: string[], message: string }
 */
export async function pullIfEnabled(cwd, config) {
  const syncConfig = config.sync || {};

  if (!syncConfig.enabled || !syncConfig.serverUrl) {
    return { synced: false, lockAcquired: false, message: 'Sync disabled' };
  }

  const client = new SyncClient(config, cwd);

  // Check server health
  const health = await client.checkHealth();
  if (!health.ok) {
    console.error(`[mneme-sync] Server unreachable, using local memory`);
    return { synced: false, lockAcquired: false, message: 'Server unreachable' };
  }

  // Try to acquire lock
  const lockResult = await client.acquireLock();
  if (!lockResult.success) {
    if (lockResult.reason === 'locked_by_other') {
      console.error(`[mneme-sync] Project locked by another machine, using local copy`);
      return {
        synced: false,
        lockAcquired: false,
        message: `Locked by ${lockResult.lock?.clientId}`
      };
    }
    console.error(`[mneme-sync] Failed to acquire lock, using local memory`);
    return { synced: false, lockAcquired: false, message: 'Lock failed' };
  }

  // List server files
  const serverFiles = await client.listServerFiles();
  if (!serverFiles.success) {
    console.error(`[mneme-sync] Failed to list server files`);
    return { synced: false, lockAcquired: true, message: 'List files failed' };
  }

  // Build map of server files by name
  const serverFileMap = new Map();
  for (const f of serverFiles.files) {
    serverFileMap.set(f.name, f);
  }

  // Download files that are newer on server
  const pulledFiles = [];
  const paths = ensureMemoryDirs(cwd);

  for (const { name, key } of FILES_TO_SYNC) {
    const localPath = paths[key];
    if (!localPath) continue;

    const serverFile = serverFileMap.get(name);
    if (!serverFile) continue; // File doesn't exist on server

    const localInfo = getLocalFileInfo(localPath);
    const serverMtimeMs = new Date(serverFile.mtime).getTime();

    // Download if server is newer or local doesn't exist
    if (!localInfo || serverMtimeMs > localInfo.mtimeMs) {
      const download = await client.downloadFile(name);
      if (download.success) {
        try {
          writeFileSync(localPath, download.content);
          pulledFiles.push(name);
        } catch (err) {
          console.error(`[mneme-sync] Failed to write ${name}: ${err.message}`);
        }
      }
    }
  }

  if (pulledFiles.length > 0) {
    console.error(`[mneme-sync] Synced from server: ${pulledFiles.join(', ')}`);
  }

  return {
    synced: true,
    lockAcquired: true,
    files: pulledFiles,
    message: pulledFiles.length > 0 ? 'Synced from server' : 'Already up to date'
  };
}

/**
 * Push files to server at session end
 *
 * @param {string} cwd - Working directory
 * @param {object} config - Full config
 * @returns {object} { pushed: boolean, files: string[], message: string }
 */
export async function pushIfEnabled(cwd, config) {
  const syncConfig = config.sync || {};

  if (!syncConfig.enabled || !syncConfig.serverUrl) {
    return { pushed: false, files: [], message: 'Sync disabled' };
  }

  const client = new SyncClient(config, cwd);

  // Check server health
  const health = await client.checkHealth();
  if (!health.ok) {
    console.error(`[mneme-sync] Server unreachable, changes saved locally only`);
    return { pushed: false, files: [], message: 'Server unreachable' };
  }

  // List server files to compare mtimes
  const serverFiles = await client.listServerFiles();
  const serverFileMap = new Map();
  if (serverFiles.success) {
    for (const f of serverFiles.files) {
      serverFileMap.set(f.name, f);
    }
  }

  // Upload files that are newer locally
  const pushedFiles = [];
  const paths = ensureMemoryDirs(cwd);

  for (const { name, key } of FILES_TO_SYNC) {
    const localPath = paths[key];
    if (!localPath || !existsSync(localPath)) continue;

    const localInfo = getLocalFileInfo(localPath);
    if (!localInfo) continue;

    const serverFile = serverFileMap.get(name);
    const serverMtimeMs = serverFile ? new Date(serverFile.mtime).getTime() : 0;

    // Upload if local is newer
    if (localInfo.mtimeMs > serverMtimeMs) {
      try {
        const content = readFileSync(localPath, 'utf-8');
        const upload = await client.uploadFile(name, content);
        if (upload.success) {
          pushedFiles.push(name);
        } else if (upload.error) {
          console.error(`[mneme-sync] Failed to upload ${name}: ${upload.error}`);
        }
      } catch (err) {
        console.error(`[mneme-sync] Failed to read ${name}: ${err.message}`);
      }
    }
  }

  // Release lock
  await client.releaseLock();

  if (pushedFiles.length > 0) {
    console.error(`[mneme-sync] Pushed to server: ${pushedFiles.join(', ')}`);
  }

  return {
    pushed: true,
    files: pushedFiles,
    message: pushedFiles.length > 0 ? 'Pushed to server' : 'No changes to push'
  };
}
