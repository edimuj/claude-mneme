#!/usr/bin/env node
/**
 * Session Stop Hook
 * Flushes pending log entries and checks for summarization when session ends
 */

import { flushPendingLog } from './utils.mjs';

const cwd = process.cwd();

// Flush all pending entries (throttle=0 forces immediate flush)
// This also triggers maybeSummarize after merging
flushPendingLog(cwd, 0);

process.exit(0);
