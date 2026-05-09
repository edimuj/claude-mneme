#!/usr/bin/env node
/**
 * Stop Hook — Forwarder to Plugin Service with client-side fallback
 *
 * Primary path: forwards hookData to CaptureService (server-side).
 * Fallback: when server is unreachable, extracts last_assistant_message
 * from hookData and writes to log.pending.jsonl so the response isn't lost.
 */

import { getClient } from '../client/mneme-client.mjs';
import { isSessionDisabled, ensureMemoryDirs, appendToPendingLog, invalidateCache } from './utils.mjs';
import { logError } from '../lib/error-log.mjs';
import { stripMarkdown } from '../lib/text.mjs';
import { execFileSync } from 'node:child_process';

if (process.env.MNEME_DISABLED === '1') process.exit(0);

function getProjectRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return cwd;
  }
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

function clientSideFallback(hookData, cwd) {
  const text = extractTextContent(hookData?.last_assistant_message);
  if (!text || text.trim().length < 10) return;

  let processed = stripMarkdown(text);
  if (processed.length > 2000) processed = processed.substring(0, 2000) + '...';

  ensureMemoryDirs(cwd);
  const entry = { ts: new Date().toISOString(), type: 'response', content: processed };
  appendToPendingLog(entry, cwd);
  invalidateCache(cwd);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  try {
    const hookData = JSON.parse(input);
    const cwd = hookData.cwd || process.cwd();
    if (isSessionDisabled(cwd)) { process.exit(0); return; }
    const project = getProjectRoot(cwd);
    const client = await getClient();
    await client.captureStop(project, hookData);
  } catch (e) {
    logError(e, 'stop-capture');
    // Fallback: persist response client-side so it's not lost
    try {
      const hookData = JSON.parse(input);
      const cwd = hookData.cwd || process.cwd();
      clientSideFallback(hookData, cwd);
    } catch { /* input wasn't valid JSON or dirs missing — nothing we can do */ }
  }
  process.exit(0);
});

// Hard timeout — don't block Claude Code
setTimeout(() => process.exit(0), 5000);
