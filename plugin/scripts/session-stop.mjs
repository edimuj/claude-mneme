#!/usr/bin/env node
/**
 * Session Stop Hook
 * Flushes pending log entries, pushes to sync server, and checks for summarization
 */

import { pathToFileURL } from 'node:url';
import { isSessionDisabled, flushPendingLog, maybeSummarize, loadConfig } from './utils.mjs';
import { logError } from '../lib/error-log.mjs';
import { pushIfEnabled, stopHeartbeat } from './sync.mjs';

const DEFAULT_SUMMARIZE_TIMEOUT_MS = 1500;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSummarizeDispatch(promise, timeoutMs, logErrorFn) {
  await Promise.race([
    Promise.resolve(promise).catch((err) => {
      logErrorFn(err, 'session-stop:maybeSummarize');
      return null;
    }),
    wait(timeoutMs).then(() => null)
  ]);
}

export async function main({
  cwd = process.cwd(),
  summarizeTimeoutMs = DEFAULT_SUMMARIZE_TIMEOUT_MS,
  loadConfigFn = loadConfig,
  stopHeartbeatFn = stopHeartbeat,
  flushPendingLogFn = flushPendingLog,
  maybeSummarizeFn = maybeSummarize,
  pushIfEnabledFn = pushIfEnabled,
  logErrorFn = logError
} = {}) {
  if (isSessionDisabled(cwd)) return;

  const config = loadConfigFn();

  // Stop the heartbeat interval
  stopHeartbeatFn();

  // Flush any remaining pending entries (throttle=0 forces immediate flush)
  flushPendingLogFn(cwd, 0);

  // Always check if summarization is needed — the server's LogService writes
  // directly to log.jsonl, so flushPendingLog may have nothing to flush and
  // would skip its internal maybeSummarize call.
  await waitForSummarizeDispatch(
    maybeSummarizeFn(cwd),
    summarizeTimeoutMs,
    logErrorFn
  );

  // Sync: push files to server if enabled
  await pushIfEnabledFn(cwd, config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      logError(err, 'session-stop');
      console.error(`[mneme] Error: ${err.message}`);
      process.exit(0); // Exit 0 — memory is non-critical, don't block session lifecycle
    });
}
