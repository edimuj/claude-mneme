import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MEMORY_BASE = join(homedir(), '.claude-mneme');

export function getErrorLogPath() {
  return join(MEMORY_BASE, 'errors.log');
}

function rotateErrorLog(logPath, maxEntries) {
  try {
    if (!existsSync(logPath)) return;

    const content = readFileSync(logPath, 'utf-8').trim();
    if (!content) return;

    const lines = content.split('\n').filter(l => l);
    if (lines.length > maxEntries) {
      const trimmed = lines.slice(-maxEntries).join('\n') + '\n';
      writeFileSync(logPath, trimmed);
    }
  } catch {
    // Ignore rotation errors
  }
}

export function logError(error, context = 'unknown') {
  try {
    const errorLogPath = getErrorLogPath();
    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : null;

    const entry = {
      ts: timestamp,
      context,
      message,
      stack: stack ? stack.split('\n').slice(1, 4).map(l => l.trim()).join(' | ') : null
    };

    if (!existsSync(MEMORY_BASE)) {
      mkdirSync(MEMORY_BASE, { recursive: true });
    }

    appendFileSync(errorLogPath, JSON.stringify(entry) + '\n');
    rotateErrorLog(errorLogPath, 100);
  } catch {
    // Can't log the error - fail silently
  }
}

export function getRecentErrors(maxCount = 10) {
  try {
    const errorLogPath = getErrorLogPath();
    if (!existsSync(errorLogPath)) {
      return [];
    }

    const content = readFileSync(errorLogPath, 'utf-8').trim();
    if (!content) return [];

    const lines = content.split('\n').filter(l => l);
    const errors = lines
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean);

    return errors.slice(-maxCount).reverse();
  } catch {
    return [];
  }
}

export function clearErrorLog() {
  try {
    const errorLogPath = getErrorLogPath();
    if (existsSync(errorLogPath)) {
      writeFileSync(errorLogPath, '');
    }
    return true;
  } catch {
    return false;
  }
}

export function getErrorsSince(hours = 24) {
  const errors = getRecentErrors(100);
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);

  return errors.filter(e => {
    const errorTime = new Date(e.ts).getTime();
    return errorTime >= cutoff;
  });
}
