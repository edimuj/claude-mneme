/**
 * Shared utilities for claude-mneme plugin
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { execFileSync, spawn } from 'child_process';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

export const MEMORY_BASE = join(homedir(), '.claude-mneme');
export const CONFIG_FILE = join(MEMORY_BASE, 'config.json');

/**
 * Get the project name from cwd
 * Uses git repo root name if available, otherwise directory name
 */
export function getProjectName(cwd = process.cwd()) {
  try {
    // Try to get git repo root using execFileSync (safer than execSync)
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return basename(gitRoot);
  } catch {
    // Not a git repo, use directory name
    return basename(cwd);
  }
}

/**
 * Get the project-specific memory directory
 */
export function getProjectMemoryDir(cwd = process.cwd()) {
  const projectName = getProjectName(cwd);
  // Sanitize project name for filesystem
  const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(MEMORY_BASE, 'projects', safeName);
}

/**
 * Ensure memory directories exist and return paths
 */
export function ensureMemoryDirs(cwd = process.cwd()) {
  const projectDir = getProjectMemoryDir(cwd);

  if (!existsSync(MEMORY_BASE)) {
    mkdirSync(MEMORY_BASE, { recursive: true });
  }

  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  return {
    base: MEMORY_BASE,
    project: projectDir,
    log: join(projectDir, 'log.jsonl'),
    summary: join(projectDir, 'summary.md'),
    config: CONFIG_FILE
  };
}

/**
 * Load config with defaults
 */
export function loadConfig() {
  const defaultConfig = {
    maxLogEntriesBeforeSummarize: 50,
    keepRecentEntries: 10,
    maxResponseLength: 1000,
    summarizeResponses: true,
    maxSummarySentences: 4,
    actionWords: [
      'fixed', 'added', 'created', 'updated', 'removed', 'deleted',
      'implemented', 'refactored', 'changed', 'modified', 'resolved',
      'installed', 'configured', 'migrated', 'moved', 'renamed',
      'error', 'bug', 'issue', 'warning', 'failed', 'success',
      'complete', 'done', 'finished', 'ready'
    ],
    model: 'claude-haiku-4-20250514',
    claudePath: 'claude'
  };

  if (existsSync(CONFIG_FILE)) {
    try {
      return { ...defaultConfig, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) };
    } catch {
      return defaultConfig;
    }
  }
  return defaultConfig;
}

/**
 * Check if summarization is needed and spawn it in background if so
 * Call this after appending to the log
 */
export function maybeSummarize(cwd = process.cwd()) {
  const paths = ensureMemoryDirs(cwd);
  const config = loadConfig();

  // Quick check: does log exist and have enough entries?
  if (!existsSync(paths.log)) {
    return;
  }

  try {
    const logContent = readFileSync(paths.log, 'utf-8').trim();
    if (!logContent) return;

    const entryCount = logContent.split('\n').filter(l => l).length;

    if (entryCount < config.maxLogEntriesBeforeSummarize) {
      return;
    }

    // Check for existing lock (avoid spawning if already running)
    const lockFile = paths.log + '.lock';
    if (existsSync(lockFile)) {
      const lockContent = readFileSync(lockFile, 'utf-8').trim();
      const lockTime = parseInt(lockContent, 10);
      if (lockTime && Date.now() - lockTime < 5 * 60 * 1000) {
        // Lock is fresh, summarization already running
        return;
      }
    }

    // Spawn summarize.mjs in background
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const summarizeScript = join(__dirname, 'summarize.mjs');

    const child = spawn('node', [summarizeScript, cwd], {
      detached: true,
      stdio: 'ignore',
      cwd: cwd
    });

    child.unref();
  } catch {
    // Silent fail - don't block the calling script
  }
}
