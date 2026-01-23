#!/usr/bin/env node
/**
 * Session Stop Hook
 * Final check for summarization when session ends
 * Acts as a fallback in case summarization wasn't triggered during the session
 */

import { maybeSummarize } from './utils.mjs';

const cwd = process.cwd();

// Run summarization check (will only run if threshold exceeded)
maybeSummarize(cwd);

process.exit(0);
