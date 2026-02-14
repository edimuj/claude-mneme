#!/usr/bin/env node
/**
 * Session Stop Hook
 * Flushes pending log entries, pushes to sync server, and checks for summarization
 */

import { flushPendingLog, maybeSummarize, loadConfig, logError } from './utils.mjs';
import { pushIfEnabled, stopHeartbeat } from './sync.mjs';

async function main() {
  const cwd = process.cwd();
  const config = loadConfig();

  // Stop the heartbeat interval
  stopHeartbeat();

  // Flush any remaining pending entries (throttle=0 forces immediate flush)
  flushPendingLog(cwd, 0);

  // Always check if summarization is needed — the server's LogService writes
  // directly to log.jsonl, so flushPendingLog may have nothing to flush and
  // would skip its internal maybeSummarize call.
  maybeSummarize(cwd);

  // Sync: push files to server if enabled
  await pushIfEnabled(cwd, config);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    logError(err, 'session-stop');
    console.error(`[mneme] Error: ${err.message}`);
    process.exit(0); // Exit 0 — memory is non-critical, don't block session lifecycle
  });
