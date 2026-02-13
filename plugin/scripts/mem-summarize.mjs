#!/usr/bin/env node
/**
 * Force Manual Summarization
 *
 * Triggers summarization regardless of entry count.
 * Used by the /summarize slash command.
 *
 * Usage: node mem-summarize.mjs [--dry-run]
 *
 * Options:
 *   --dry-run   Show what would be summarized without actually doing it
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import {
  ensureDeps,
  ensureMemoryDirs,
  loadConfig,
  getProjectName,
  formatEntriesForSummary,
  emptyStructuredSummary,
  deduplicateEntries,
  flushPendingLog,
  withoutNestedSessionGuard,
  logError
} from './utils.mjs';

const cwd = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const paths = ensureMemoryDirs(cwd);
const config = loadConfig();
const projectName = getProjectName(cwd);

// Flush any pending entries first
flushPendingLog(cwd, 0);

// Check if log exists
if (!existsSync(paths.log)) {
  console.log(JSON.stringify({
    project: projectName,
    status: 'empty',
    message: 'No log entries to summarize.'
  }));
  process.exit(0);
}

const logContent = readFileSync(paths.log, 'utf-8').trim();
if (!logContent) {
  console.log(JSON.stringify({
    project: projectName,
    status: 'empty',
    message: 'No log entries to summarize.'
  }));
  process.exit(0);
}

const lines = logContent.split('\n').filter(l => l);
const entryCount = lines.length;

// Check for lock
const lockFile = paths.log + '.lock';
if (existsSync(lockFile)) {
  const lockContent = readFileSync(lockFile, 'utf-8').trim();
  const lockTime = parseInt(lockContent, 10);
  if (lockTime && Date.now() - lockTime < 5 * 60 * 1000) {
    console.log(JSON.stringify({
      project: projectName,
      status: 'locked',
      message: 'Summarization already in progress.'
    }));
    process.exit(0);
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
  process.exit(0);
}

// Minimum entries to summarize (at least 3 to be meaningful)
const minEntriesToSummarize = 3;
if (entryCount < minEntriesToSummarize) {
  console.log(JSON.stringify({
    project: projectName,
    status: 'skipped',
    message: `Only ${entryCount} entries. Need at least ${minEntriesToSummarize} to summarize.`,
    logEntries: entryCount
  }));
  process.exit(0);
}

// Acquire lock
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
    process.exit(0);
  }

  const entriesToSummarize = lines.slice(0, summarizeCount);
  const entriesToKeep = lines.slice(summarizeCount);

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

  async function* messageGenerator() {
    yield {
      type: 'user',
      message: { role: 'user', content: prompt },
      session_id: `memory-summarize-manual-${Date.now()}`,
      parent_tool_use_id: null,
      isSynthetic: true
    };
  }

  const response = await withoutNestedSessionGuard(async () => {
    let stderrOutput = '';
    const queryResult = query({
      prompt: messageGenerator(),
      options: {
        model: config.model,
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'],
        pathToClaudeCodeExecutable: config.claudePath,
        stderr: (data) => { stderrOutput += data; }
      }
    });

    let result = '';
    try {
      for await (const message of queryResult) {
        if (message.type === 'assistant') {
          const content = message.message.content;
          result = Array.isArray(content)
            ? content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            : typeof content === 'string' ? content : '';
        }
      }
    } catch (iterError) {
      if (!result) {
        iterError.message += stderrOutput ? ` | stderr: ${stderrOutput.slice(0, 500)}` : ' | no stderr';
        throw iterError;
      }
    }
    return result;
  });

  if (!response) {
    throw new Error('No response from summarization model');
  }

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse JSON from response');
  }

  const updates = JSON.parse(jsonMatch[0]);

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

  // Re-read the log to preserve any entries appended during summarization
  const currentLogContent = readFileSync(paths.log, 'utf-8').trim();
  const currentLines = currentLogContent ? currentLogContent.split('\n').filter(l => l) : [];
  const remainingLines = currentLines.slice(summarizeCount);
  writeFileSync(paths.log, remainingLines.join('\n') + (remainingLines.length ? '\n' : ''));

  console.log(JSON.stringify({
    project: projectName,
    status: 'success',
    summarized: entriesToSummarize.length,
    kept: remainingLines.length,
    summaryUpdated: result.lastUpdated
  }));

} catch (error) {
  logError(error, 'summarize');
  console.log(JSON.stringify({
    project: projectName,
    status: 'error',
    message: error.message
  }));
  process.exit(1);

} finally {
  try { unlinkSync(lockFile); } catch {}
}
