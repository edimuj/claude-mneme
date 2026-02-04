#!/usr/bin/env node
/**
 * Incremental Summarization Script
 *
 * Usage: node summarize.mjs <project-dir>
 *        node summarize.mjs <project-dir> --migrate   (migrate old summary.md to JSON)
 *
 * Uses structured JSON storage for efficient incremental updates.
 * Only new entries are sent to Haiku, not the entire summary.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import {
  ensureMemoryDirs,
  loadConfig,
  getProjectName,
  formatEntriesForSummary,
  emptyStructuredSummary,
  renderSummaryToMarkdown,
  deduplicateEntries
} from './utils.mjs';

const cwd = process.argv[2] || process.cwd();
const migrateOnly = process.argv.includes('--migrate');
const paths = ensureMemoryDirs(cwd);
const config = loadConfig();
const projectName = getProjectName(cwd);

/**
 * Read existing structured summary, or return empty structure
 */
function readStructuredSummary() {
  if (existsSync(paths.summaryJson)) {
    try {
      return JSON.parse(readFileSync(paths.summaryJson, 'utf-8'));
    } catch {
      return emptyStructuredSummary();
    }
  }
  return emptyStructuredSummary();
}

/**
 * Migrate old markdown summary to structured JSON format
 */
async function migrateMarkdownSummary() {
  if (!existsSync(paths.summary)) {
    console.error('[claude-mneme] No summary.md to migrate');
    return null;
  }

  const markdown = readFileSync(paths.summary, 'utf-8').trim();
  if (!markdown) {
    return emptyStructuredSummary();
  }

  console.error(`[claude-mneme] Migrating summary.md to structured JSON for "${projectName}"...`);

  const prompt = `Convert this markdown memory summary into structured JSON format.

<markdown_summary>
${markdown}
</markdown_summary>

Output a JSON object with this exact structure:
{
  "projectContext": "Brief description of what this project is (1-2 sentences)",
  "keyDecisions": [
    { "date": "YYYY-MM-DD or null", "decision": "The decision made", "reason": "Why it was made or null" }
  ],
  "currentState": [
    { "topic": "Feature/component name", "status": "Current implementation status" }
  ],
  "recentWork": [
    { "date": "YYYY-MM-DD or null", "summary": "What was done" }
  ]
}

Rules:
- Extract project context from any "Project Context" or introductory section
- Key decisions are architectural choices, technology selections, design patterns
- Current state describes what's implemented, in progress, or known issues
- Recent work is the latest activity that hasn't been folded into current state yet
- Use null for dates if not clearly specified
- Output ONLY the JSON object, no other text`;

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    async function* messageGenerator() {
      yield {
        type: 'user',
        message: { role: 'user', content: prompt },
        session_id: `memory-migrate-${Date.now()}`,
        parent_tool_use_id: null,
        isSynthetic: true
      };
    }

    const queryResult = query({
      prompt: messageGenerator(),
      options: {
        model: config.model,
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'],
        pathToClaudeCodeExecutable: config.claudePath
      }
    });

    let response = '';
    try {
      for await (const message of queryResult) {
        if (message.type === 'assistant') {
          const content = message.message.content;
          response = Array.isArray(content)
            ? content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            : typeof content === 'string' ? content : '';
        }
      }
    } catch (iterError) {
      if (!response) throw iterError;
    }

    if (response) {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const migrated = JSON.parse(jsonMatch[0]);
        migrated.lastUpdated = new Date().toISOString();
        return migrated;
      }
    }
  } catch (error) {
    console.error(`[claude-mneme] Migration error: ${error.message}`);
  }

  return null;
}

/**
 * Perform incremental summarization of new entries
 */
async function incrementalSummarize(existingSummary, newEntries) {
  // Parse entries for deduplication
  const parsedEntries = newEntries.map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);

  // Deduplicate before sending to LLM - reduces noise and cost
  const deduped = deduplicateEntries(parsedEntries, config);
  const dedupedLines = deduped.map(e => JSON.stringify(e));

  const entriesText = formatEntriesForSummary(dedupedLines);

  // Build a compact representation of existing summary for context
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
  const recentCount = existingSummary.recentWork?.length || 0;

  const prompt = `You are updating a structured memory for project "${projectName}".

<existing_context>
${existingContext.join('\n') || '(New project, no existing context)'}
Recent work items: ${recentCount}
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
  "promoteToCurrentState": ["indices of recentWork items to promote, e.g. 0, 1"],
  "removeFromRecentWork": ["indices of recentWork items that are now stale"]
}

Rules:
- Only include fields that have updates (use empty arrays for no changes)
- Key decisions: major architectural choices, technology decisions, design patterns
- Current state: features implemented, work in progress, known issues
- Recent work: specific tasks completed in this batch of entries
- Merge similar entries, avoid duplicates
- Be concise — each item should be one clear sentence
- Output ONLY the JSON object`;

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    async function* messageGenerator() {
      yield {
        type: 'user',
        message: { role: 'user', content: prompt },
        session_id: `memory-summarize-${Date.now()}`,
        parent_tool_use_id: null,
        isSynthetic: true
      };
    }

    const queryResult = query({
      prompt: messageGenerator(),
      options: {
        model: config.model,
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'],
        pathToClaudeCodeExecutable: config.claudePath
      }
    });

    let response = '';
    try {
      for await (const message of queryResult) {
        if (message.type === 'assistant') {
          const content = message.message.content;
          response = Array.isArray(content)
            ? content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            : typeof content === 'string' ? content : '';
        }
      }
    } catch (iterError) {
      if (!response) throw iterError;
    }

    if (response) {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    }
  } catch (error) {
    console.error(`[claude-mneme] Summarization error: ${error.message}`);
  }

  return null;
}

/**
 * Apply incremental updates to existing summary
 */
function applyUpdates(existing, updates) {
  const result = { ...existing };

  // Update project context if provided
  if (updates.projectContext) {
    result.projectContext = updates.projectContext;
  }

  // Add new key decisions
  if (updates.newKeyDecisions?.length > 0) {
    result.keyDecisions = [...(result.keyDecisions || []), ...updates.newKeyDecisions];
  }

  // Update current state (merge by topic)
  if (updates.updateCurrentState?.length > 0) {
    const stateMap = new Map((result.currentState || []).map(s => [s.topic, s]));
    for (const update of updates.updateCurrentState) {
      stateMap.set(update.topic, update);
    }
    result.currentState = Array.from(stateMap.values());
  }

  // Handle recentWork: remove stale, promote, add new
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
        // Add to current state as a completed item
        result.currentState = result.currentState || [];
        result.currentState.push({
          topic: 'Completed',
          status: item.summary
        });
      }
    }
    recentWork = recentWork.filter((_, i) => !toPromote.has(i));
  }

  // Add new recent work
  if (updates.newRecentWork?.length > 0) {
    recentWork = [...recentWork, ...updates.newRecentWork];
  }

  // Keep only last 10 recent work items
  result.recentWork = recentWork.slice(-10);

  // Limit current state to 15 items (oldest get removed)
  if (result.currentState?.length > 15) {
    result.currentState = result.currentState.slice(-15);
  }

  // Limit key decisions to 10 (oldest get removed)
  if (result.keyDecisions?.length > 10) {
    result.keyDecisions = result.keyDecisions.slice(-10);
  }

  result.lastUpdated = new Date().toISOString();

  return result;
}

// ============ Main execution ============

// Handle migration mode
if (migrateOnly) {
  const migrated = await migrateMarkdownSummary();
  if (migrated) {
    writeFileSync(paths.summaryJson, JSON.stringify(migrated, null, 2) + '\n');
    console.error(`[claude-mneme] Migration complete. Created summary.json for "${projectName}".`);
    console.error('[claude-mneme] You can delete summary.md if the migration looks correct.');
  }
  process.exit(0);
}

// Check if log exists and has entries
if (!existsSync(paths.log)) {
  process.exit(0);
}

const logContent = readFileSync(paths.log, 'utf-8').trim();
if (!logContent) {
  process.exit(0);
}

const lines = logContent.split('\n').filter(l => l);
const entryCount = lines.length;

// Check if we need to summarize
if (entryCount < config.maxLogEntriesBeforeSummarize) {
  process.exit(0);
}

// Use a lock file to prevent concurrent summarizations
const lockFile = paths.log + '.lock';
if (existsSync(lockFile)) {
  const lockStat = readFileSync(lockFile, 'utf-8');
  const lockTime = parseInt(lockStat, 10);
  if (Date.now() - lockTime < 5 * 60 * 1000) {
    process.exit(0);
  }
}

writeFileSync(lockFile, Date.now().toString());

try {
  // Check if we need to migrate first
  let existingSummary = readStructuredSummary();
  if (!existingSummary.lastUpdated && existsSync(paths.summary)) {
    console.error(`[claude-mneme] Migrating existing summary.md to JSON format...`);
    const migrated = await migrateMarkdownSummary();
    if (migrated) {
      existingSummary = migrated;
      writeFileSync(paths.summaryJson, JSON.stringify(existingSummary, null, 2) + '\n');
    }
  }

  // Calculate entries to summarize vs keep
  const summarizeCount = entryCount - config.keepRecentEntries;
  if (summarizeCount <= 0) {
    process.exit(0);
  }

  const entriesToSummarize = lines.slice(0, summarizeCount);
  const entriesToKeep = lines.slice(summarizeCount);

  console.error(`[claude-mneme] Incrementally summarizing ${entriesToSummarize.length} entries for "${projectName}"...`);

  // Run incremental summarization
  const updates = await incrementalSummarize(existingSummary, entriesToSummarize);

  if (updates) {
    const newSummary = applyUpdates(existingSummary, updates);
    writeFileSync(paths.summaryJson, JSON.stringify(newSummary, null, 2) + '\n');

    // Also write markdown version for backwards compatibility / human readability
    const markdown = renderSummaryToMarkdown(newSummary, projectName);
    writeFileSync(paths.summary, markdown + '\n');

    // Trim the log
    writeFileSync(paths.log, entriesToKeep.join('\n') + (entriesToKeep.length ? '\n' : ''));

    console.error(`[claude-mneme] Summary updated. Kept ${entriesToKeep.length} recent entries.`);
  } else {
    console.error('[claude-mneme] Summarization returned no updates, keeping log intact.');
  }

} finally {
  try { writeFileSync(lockFile, ''); } catch {}
}

process.exit(0);
