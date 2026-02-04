#!/usr/bin/env node
/**
 * Session Start Hook
 * Reads project-specific memory context and outputs it for injection
 *
 * Uses hierarchical context injection:
 * - HIGH priority: Project context, key decisions, current state, remembered items
 * - MEDIUM priority: Recent work, git changes, active entities
 * - LOW priority: Recent log entries (limited to last few)
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { ensureMemoryDirs, loadConfig, getProjectName, formatEntry, renderSummaryToMarkdown, flushPendingLog, scoreEntriesByRelevance, getRelevantEntities, deduplicateEntries, readCachedData } from './utils.mjs';
import { pullIfEnabled, startHeartbeat } from './sync.mjs';

async function main() {
  const cwd = process.cwd();
  const paths = ensureMemoryDirs(cwd);
  const config = loadConfig();
  const projectName = getProjectName(cwd);
  const ciConfig = config.contextInjection || {};
  const sections = ciConfig.sections || {};

  // Flush any pending log entries from previous session
  flushPendingLog(cwd, 0);

  // Sync: pull files from server if enabled (before reading cached data)
  const syncResult = await pullIfEnabled(cwd, config);
  if (syncResult.lockAcquired) {
    startHeartbeat(cwd, config);
  }

  // Clean up task tracking — task IDs are session-scoped and reset each session
  const taskTrackingPath = join(paths.project, 'active-tasks.json');
  try { if (existsSync(taskTrackingPath)) unlinkSync(taskTrackingPath); } catch {}

  // ============================================================================
  // Read all data using cache (avoids redundant file reads/parsing)
  // ============================================================================
  const cachedData = readCachedData(cwd, config);

  // ============================================================================
  // HIGH PRIORITY - Always inject
  // ============================================================================

  // Render structured summary
  let summaryParts = { high: '', medium: '', full: '' };

  if (cachedData.summary) {
    summaryParts = renderSummaryToMarkdown(cachedData.summary, projectName, ciConfig);
  } else if (existsSync(paths.summary)) {
    // Fall back to markdown if no JSON summary
    try {
      summaryParts.full = readFileSync(paths.summary, 'utf-8').trim();
      summaryParts.high = summaryParts.full;
    } catch {}
  }

  // Read persistent remembered items (HIGH priority)
  let remembered = [];
  const remConfig = sections.remembered || { enabled: true };
  if (remConfig.enabled !== false) {
    remembered = cachedData.remembered || [];
  }

  // ============================================================================
  // MEDIUM PRIORITY - Inject if relevant/recent
  // ============================================================================

  // Git changes since last session
  let gitChanges = '';
  const gcConfig = sections.gitChanges || { enabled: true };
  if (gcConfig.enabled !== false) {
    try {
      let sinceArg = null;
      if (existsSync(paths.lastSession)) {
        sinceArg = readFileSync(paths.lastSession, 'utf-8').trim();
      }
      if (sinceArg) {
        const log = execFileSync('git', ['log', '--oneline', `--since=${sinceArg}`], {
          encoding: 'utf8',
          cwd,
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (log) gitChanges = log;
      }
    } catch {
      // Not a git repo or git error — skip silently
    }
  }

  // Get relevant entities for context (MEDIUM priority)
  let relevantEntities = null;
  const aeConfig = sections.activeEntities || { enabled: true, maxFiles: 5, maxFunctions: 5 };
  const eeConfig = config.entityExtraction || {};
  if (aeConfig.enabled !== false && eeConfig.enabled !== false) {
    try {
      relevantEntities = getRelevantEntities(cwd);
    } catch {
      // Ignore errors
    }
  }

  // ============================================================================
  // LOW PRIORITY - Minimal injection
  // ============================================================================

  // Process log entries by relevance (LOW priority - reduced count)
  let recentEntries = [];
  const reConfig = sections.recentEntries || { enabled: true, maxItems: 4 };
  if (reConfig.enabled !== false && cachedData.logEntries.length > 0) {
    // Filter out response entries (low signal)
    let meaningful = cachedData.logEntries.filter(e => e.type !== 'response');

    // Apply semantic deduplication - group related entries and keep highest signal
    meaningful = deduplicateEntries(meaningful, config);

    // Use hierarchical limit (default 4, not 10)
    const maxEntries = reConfig.maxItems || 4;
    const rsConfig = config.relevanceScoring || {};

    if (rsConfig.enabled !== false && meaningful.length > maxEntries) {
      // Score and rank by relevance
      const ranked = scoreEntriesByRelevance(meaningful, cwd, config);
      recentEntries = ranked.slice(0, maxEntries).map(formatEntry);
    } else {
      // Fall back to simple recency
      recentEntries = meaningful.slice(-maxEntries).map(formatEntry);
    }
  }

  // Write current timestamp for next session
  try {
    writeFileSync(paths.lastSession, new Date().toISOString(), 'utf-8');
  } catch {
    // Ignore write errors
  }

  // ============================================================================
  // Output - Hierarchical injection
  // ============================================================================

  const hasContent = summaryParts.high || summaryParts.medium ||
                     remembered.length > 0 || gitChanges ||
                     recentEntries.length > 0 || relevantEntities;

  if (hasContent) {
    console.log(`<claude-mneme project="${projectName}">`);

    // HIGH PRIORITY SECTION
    if (summaryParts.high) {
      console.log(summaryParts.high);
    }

    if (remembered.length > 0) {
      console.log('\n## Remembered\n');
      for (const item of remembered) {
        console.log(`- [${item.type}] ${item.content}`);
      }
    }

    // MEDIUM PRIORITY SECTION
    if (summaryParts.medium) {
      console.log(summaryParts.medium);
    }

    if (gitChanges) {
      console.log('\n## Changes Since Last Session\n');
      console.log(gitChanges);
    }

    if (relevantEntities) {
      const maxFiles = aeConfig.maxFiles || 5;
      const maxFunctions = aeConfig.maxFunctions || 5;
      const hasEntities = (relevantEntities.files?.length > 0) ||
                          (relevantEntities.functions?.length > 0);
      if (hasEntities) {
        console.log('\n## Recently Active\n');
        if (relevantEntities.files?.length > 0) {
          const topFiles = relevantEntities.files.slice(0, maxFiles);
          console.log('**Files:** ' + topFiles.map(f => `\`${f.name}\``).join(', '));
        }
        if (relevantEntities.functions?.length > 0) {
          const topFunctions = relevantEntities.functions.slice(0, maxFunctions);
          console.log('**Functions:** ' + topFunctions.map(f => `\`${f.name}\``).join(', '));
        }
      }
    }

    // LOW PRIORITY SECTION
    if (recentEntries.length > 0) {
      console.log('\n## Recent Activity\n');
      recentEntries.forEach(entry => console.log(`- ${entry}`));
    }

    console.log('\nTip: Use /remember to save key decisions, preferences, or project context for future sessions.');
    console.log('</claude-mneme>');
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(`[mneme] Error: ${err.message}`);
    process.exit(1);
  });
