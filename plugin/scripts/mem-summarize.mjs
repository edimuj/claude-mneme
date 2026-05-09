#!/usr/bin/env node
/**
 * Force Manual Summarization
 *
 * Triggers summarization regardless of entry count.
 * Used by the /summarize slash command and dashboard.
 *
 * Usage: node mem-summarize.mjs [--dry-run] [--force] [--project-dir <dir>]
 *
 * Options:
 *   --dry-run       Show what would be summarized without actually doing it
 *   --force         Skip minimum entry count check
 *   --project-dir   Use memory dir directly (bypasses cwd-based resolution)
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { formatEntriesForSummary, emptyStructuredSummary } from '../lib/summary-format.mjs';
import { logError } from '../lib/error-log.mjs';
import { queryJsonWithRetry } from '../lib/llm-query.mjs';
import {
  ensureMemoryDirs,
  loadConfig,
  getProjectName,
  deduplicateEntries,
  flushPendingLog,
  withFileLock
} from './utils.mjs';
import { getLogFileState, writeLogMetadata } from '../lib/log-metadata.mjs';

const DEFAULT_TRUNCATE_LOCK_TIMEOUT_MS = 2000;
const DEFAULT_TRUNCATE_RETRY_DELAY_MS = 25;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPaths(projectDirArg) {
  const base = join(homedir(), '.claude-mneme');
  return {
    base,
    project: projectDirArg,
    log: join(projectDirArg, 'log.jsonl'),
    summaryJson: join(projectDirArg, 'summary.json'),
    summary: join(projectDirArg, 'summary.md'),
    remembered: join(projectDirArg, 'remembered.json'),
    entities: join(projectDirArg, 'entities.json'),
    cache: join(projectDirArg, '.cache.json'),
    lastSession: join(projectDirArg, '.last-session'),
    handoff: join(projectDirArg, 'handoff.json'),
    config: join(base, 'config.json'),
  };
}

export async function truncateLogSafely({
  logPath,
  summarizeCount,
  writeLockPath = `${logPath}.wlock`,
  staleSec = 30,
  retryDelayMs = DEFAULT_TRUNCATE_RETRY_DELAY_MS,
  timeoutMs = DEFAULT_TRUNCATE_LOCK_TIMEOUT_MS,
  withFileLockFn = withFileLock,
  readFileSyncFn = readFileSync,
  writeFileSyncFn = writeFileSync,
  existsSyncFn = existsSync,
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const keptCount = withFileLockFn(writeLockPath, () => {
      const currentLogContent = existsSyncFn(logPath) ? readFileSyncFn(logPath, 'utf-8').trim() : '';
      const currentLines = currentLogContent ? currentLogContent.split('\n').filter(Boolean) : [];
      const remainingLines = currentLines.slice(summarizeCount);
      writeFileSyncFn(logPath, remainingLines.join('\n') + (remainingLines.length ? '\n' : ''));
      writeLogMetadata(logPath, remainingLines.length, getLogFileState(logPath));
      return remainingLines.length;
    }, staleSec);

    if (keptCount !== undefined) {
      return keptCount;
    }

    if (Date.now() >= deadline) {
      throw new Error('Timed out acquiring log write lock for manual summarize');
    }

    await sleep(retryDelayMs);
  }
}

export async function main({
  argv = process.argv.slice(2),
  cwd = process.cwd()
} = {}) {
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const projectDirIdx = argv.indexOf('--project-dir');
  const projectDirArg = projectDirIdx >= 0 ? argv[projectDirIdx + 1] : null;

  let paths;
  let projectName;

  if (projectDirArg) {
    // Dashboard mode: memory dir provided directly
    projectName = basename(projectDirArg);
    paths = buildPaths(projectDirArg);
  } else {
    paths = ensureMemoryDirs(cwd);
    projectName = getProjectName(cwd);
    // Flush any pending entries first
    flushPendingLog(cwd, 0);
  }

  const config = loadConfig();

  // Check if log exists
  if (!existsSync(paths.log)) {
    console.log(JSON.stringify({
      project: projectName,
      status: 'empty',
      message: 'No log entries to summarize.'
    }));
    return;
  }

  const logContent = readFileSync(paths.log, 'utf-8').trim();
  if (!logContent) {
    console.log(JSON.stringify({
      project: projectName,
      status: 'empty',
      message: 'No log entries to summarize.'
    }));
    return;
  }

  const lines = logContent.split('\n').filter(Boolean);
  const entryCount = lines.length;

  // Check for lock
  const lockFile = `${paths.log}.lock`;
  if (existsSync(lockFile)) {
    const lockContent = readFileSync(lockFile, 'utf-8').trim();
    const lockTime = parseInt(lockContent, 10);
    if (lockTime && Date.now() - lockTime < 5 * 60 * 1000) {
      console.log(JSON.stringify({
        project: projectName,
        status: 'locked',
        message: 'Summarization already in progress.'
      }));
      return;
    }
  }

  // Dry run - just report what would happen
  if (dryRun) {
    const keepCount = Math.min(config.keepRecentEntries, entryCount);
    const summarizeCount = entryCount - keepCount;

    // Read existing summary state
    let hasSummary = false;
    if (existsSync(paths.summaryJson)) {
      try {
        const summary = JSON.parse(readFileSync(paths.summaryJson, 'utf-8'));
        hasSummary = !!summary.lastUpdated;
      } catch (e) {
        logError(e, 'mem-summarize:summary.json');
      }
    }

    console.log(JSON.stringify({
      project: projectName,
      status: 'dry_run',
      logEntries: entryCount,
      wouldSummarize: summarizeCount,
      wouldKeep: keepCount,
      hasSummary,
      summaryPath: paths.summaryJson
    }, null, 2));
    return;
  }

  // Minimum entries to summarize (at least 3 to be meaningful)
  const minEntriesToSummarize = 3;
  if (!force && entryCount < minEntriesToSummarize) {
    console.log(JSON.stringify({
      project: projectName,
      status: 'skipped',
      message: `Only ${entryCount} entries. Need at least ${minEntriesToSummarize} to summarize.`,
      logEntries: entryCount
    }));
    return;
  }

  // Acquire summarization lock
  writeFileSync(lockFile, Date.now().toString());

  try {
    // Ensure SDK is installed, then import
    ensureDeps();
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    // Read existing summary
    let existingSummary = emptyStructuredSummary();
    if (existsSync(paths.summaryJson)) {
      try {
        existingSummary = JSON.parse(readFileSync(paths.summaryJson, 'utf-8'));
      } catch (e) {
        logError(e, 'mem-summarize:existingSummary');
      }
    }

    // Calculate entries to summarize vs keep
    const summarizeCount = Math.max(0, entryCount - config.keepRecentEntries);
    if (summarizeCount === 0) {
      console.log(JSON.stringify({
        project: projectName,
        status: 'skipped',
        message: 'All entries are within the keep-recent window.',
        logEntries: entryCount,
        keepRecentEntries: config.keepRecentEntries
      }));
      return;
    }

    const entriesToSummarize = lines.slice(0, summarizeCount);

    // Parse and deduplicate entries
    const parsedEntries = entriesToSummarize.map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean);

    const deduped = deduplicateEntries(parsedEntries, config);
    const dedupedLines = deduped.map(e => JSON.stringify(e));
    const entriesText = formatEntriesForSummary(dedupedLines);

    // Build context from existing summary
    const existingContext = [];
    if (existingSummary.projectContext) {
      existingContext.push(`Project: ${existingSummary.projectContext}`);
    }
    if (existingSummary.keyDecisions?.length > 0) {
      existingContext.push(`Key decisions: ${existingSummary.keyDecisions.map(d => d.decision).join('; ')}`);
    }
    if (existingSummary.currentState?.length > 0) {
      existingContext.push(`Current state: ${existingSummary.currentState.map(s => `${s.topic}: ${s.status}`).join('; ')}`);
    }

    const prompt = `You are updating a structured memory for project "${projectName}".

<existing_context>
${existingContext.join('\n') || '(New project, no existing context)'}
Recent work items: ${existingSummary.recentWork?.length || 0}
</existing_context>

<new_entries>
${entriesText}
</new_entries>

Analyze the new entries and output a JSON object with updates:

{
  "projectContext": "Updated project description if new info changes it, or null to keep existing",
  "newKeyDecisions": [
    { "date": "YYYY-MM-DD", "decision": "Important architectural/design choice", "reason": "Why" }
  ],
  "updateCurrentState": [
    { "topic": "Feature name", "status": "New or updated status" }
  ],
  "newRecentWork": [
    { "date": "YYYY-MM-DD", "summary": "What was done" }
  ],
  "promoteToCurrentState": [],
  "removeFromRecentWork": []
}

Rules:
- Only include fields that have updates (use empty arrays for no changes)
- Key decisions: major architectural choices, technology decisions, design patterns
- Current state: features implemented, work in progress, known issues
- Recent work: specific tasks completed in this batch of entries
- Merge similar entries, avoid duplicates
- Be concise — each item should be one clear sentence
- Output ONLY the JSON object`;

    console.error(`[claude-mneme] Summarizing ${entriesToSummarize.length} entries for "${projectName}"...`);

    const updates = await queryJsonWithRetry(prompt, 'memory-summarize-manual', config);

    // Apply updates to summary
    const result = { ...existingSummary };

    if (updates.projectContext) {
      result.projectContext = updates.projectContext;
    }

    if (updates.newKeyDecisions?.length > 0) {
      result.keyDecisions = [...(result.keyDecisions || []), ...updates.newKeyDecisions];
    }

    if (updates.updateCurrentState?.length > 0) {
      const stateMap = new Map((result.currentState || []).map(s => [s.topic, s]));
      for (const update of updates.updateCurrentState) {
        stateMap.set(update.topic, update);
      }
      result.currentState = Array.from(stateMap.values());
    }

    let recentWork = [...(result.recentWork || [])];

    // Remove stale items (process in reverse to preserve indices)
    if (updates.removeFromRecentWork?.length > 0) {
      const toRemove = new Set(updates.removeFromRecentWork.map(Number));
      recentWork = recentWork.filter((_, i) => !toRemove.has(i));
    }

    // Promote items to current state
    if (updates.promoteToCurrentState?.length > 0) {
      const toPromote = new Set(updates.promoteToCurrentState.map(Number));
      for (const idx of toPromote) {
        if (result.recentWork?.[idx]) {
          const item = result.recentWork[idx];
          result.currentState = result.currentState || [];
          result.currentState.push({
            topic: 'Completed',
            status: item.summary
          });
        }
      }
      recentWork = recentWork.filter((_, i) => !toPromote.has(i));
    }

    if (updates.newRecentWork?.length > 0) {
      recentWork = [...recentWork, ...updates.newRecentWork];
    }
    result.recentWork = recentWork.slice(-10);

    if (result.currentState?.length > 15) {
      result.currentState = result.currentState.slice(-15);
    }
    if (result.keyDecisions?.length > 10) {
      result.keyDecisions = result.keyDecisions.slice(-10);
    }

    result.lastUpdated = new Date().toISOString();

    // Write updated summary
    writeFileSync(paths.summaryJson, JSON.stringify(result, null, 2) + '\n');

    const keptCount = await truncateLogSafely({
      logPath: paths.log,
      summarizeCount
    });

    console.log(JSON.stringify({
      project: projectName,
      status: 'success',
      summarized: entriesToSummarize.length,
      kept: keptCount,
      summaryUpdated: result.lastUpdated
    }));

  } catch (error) {
    logError(error, 'summarize');
    console.log(JSON.stringify({
      project: projectName,
      status: 'error',
      message: error.message
    }));
    process.exitCode = 1;

  } finally {
    try { unlinkSync(lockFile); } catch {}
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    logError(error, 'summarize');
    console.log(JSON.stringify({
      project: basename(process.cwd()),
      status: 'error',
      message: error.message
    }));
    process.exit(1);
  });
}
