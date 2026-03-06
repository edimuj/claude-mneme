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

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { ensureMemoryDirs, loadConfig, getProjectName, escapeAttr, formatEntry, formatDecisionLine, renderSummaryToMarkdown, flushPendingLog, scoreEntriesByRelevance, getRelevantEntities, deduplicateEntries, readCachedData, logError, getErrorsSince } from './utils.mjs';
import { pullIfEnabled, startHeartbeat } from './sync.mjs';
import { gatherContextSignals, extractSearchTerms, retrieveRelevantMemory } from '../lib/memory-retriever.mjs';

/**
 * Render summary sections from retrieval results (scored/filtered items).
 * Same output format as renderSummaryToMarkdown but with fewer, more relevant items.
 */
function renderRetrievalSummary(retrieval, summary, projectName) {
  const highLines = ['# Claude Memory Summary'];

  if (summary.lastUpdated) {
    const ts = new Date(summary.lastUpdated).toISOString().replace('T', ' ').split('.')[0] + ' UTC';
    highLines.push(`\n*Last updated: ${ts}*`);
  }

  // Project Context — always include (not scored, it's a single paragraph)
  if (retrieval.projectContext) {
    highLines.push('\n## Project Context');
    highLines.push(retrieval.projectContext);
  }

  // Key Decisions — relevance-filtered
  if (retrieval.decisions?.length > 0) {
    highLines.push('\n## Key Decisions');
    for (const d of retrieval.decisions) {
      highLines.push(formatDecisionLine(d));
    }
  }

  // Current State — relevance-filtered
  if (retrieval.state?.length > 0) {
    highLines.push('\n## Current State');
    for (const s of retrieval.state) {
      highLines.push(`- **${s.topic}**: ${s.status}`);
    }
  }

  // Recent Work — relevance-filtered (medium priority)
  const mediumLines = [];
  if (retrieval.work?.length > 0) {
    mediumLines.push('\n## Recent Work');
    for (const w of retrieval.work) {
      const date = w.date ? `[${w.date}] ` : '';
      mediumLines.push(`- ${date}${w.summary}`);
    }
  }

  return {
    high: highLines.join('\n'),
    medium: mediumLines.join('\n'),
    full: highLines.concat(mediumLines).join('\n'),
  };
}

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

  // ============================================================================
  // Read all data using cache (avoids redundant file reads/parsing)
  // ============================================================================
  const cachedData = readCachedData(cwd, config);

  // ============================================================================
  // Context-Aware Retrieval — score memory by relevance to current work
  // ============================================================================
  let retrieval = null;
  const retrievalConfig = config.memoryRetrieval || {};
  if (retrievalConfig.enabled !== false) {
    try {
      const signals = gatherContextSignals(cwd, cachedData, paths);
      const searchTerms = extractSearchTerms(signals);
      retrieval = retrieveRelevantMemory(searchTerms, cachedData, config);
    } catch (e) {
      logError(e, 'session-start:retrieval');
      // Falls through to legacy path
    }
  }

  // ============================================================================
  // HIGH PRIORITY - Always inject
  // ============================================================================

  // Render structured summary
  let summaryParts = { high: '', medium: '', full: '' };

  if (cachedData.summary) {
    if (retrieval) {
      // Retrieval-aware: render only relevant items from scored results
      summaryParts = renderRetrievalSummary(retrieval, cachedData.summary, projectName);
    } else {
      // Fallback: dump everything (existing behavior)
      summaryParts = renderSummaryToMarkdown(cachedData.summary, projectName, ciConfig);
    }
  }

  // Read persistent remembered items (HIGH priority)
  let remembered = [];
  const remConfig = sections.remembered || { enabled: true };
  if (remConfig.enabled !== false) {
    remembered = retrieval ? (retrieval.remembered || []) : (cachedData.remembered || []);
  }

  // ============================================================================
  // MEDIUM PRIORITY - Inject if relevant/recent
  // ============================================================================

  // Read last session timestamp (used for git changes and temporal header)
  let lastSessionTs = null;
  if (existsSync(paths.lastSession)) {
    try {
      lastSessionTs = readFileSync(paths.lastSession, 'utf-8').trim() || null;
    } catch {}
  }

  // Git changes since last session
  let gitChanges = '';
  const gcConfig = sections.gitChanges || { enabled: true };
  if (gcConfig.enabled !== false) {
    try {
      if (lastSessionTs) {
        const log = execFileSync('git', ['log', '--oneline', `--since=${lastSessionTs}`], {
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
    } catch (e) {
      logError(e, 'session-start:getRelevantEntities');
    }
  }

  // ============================================================================
  // LOW PRIORITY - Minimal injection
  // ============================================================================

  // Process log entries by relevance (LOW priority - reduced count)
  let recentEntries = [];
  const reConfig = sections.recentEntries || { enabled: true, maxItems: 4 };
  if (retrieval) {
    // Retrieval-aware: entries already scored and filtered
    recentEntries = (retrieval.entries || []).map(formatEntry);
  } else if (reConfig.enabled !== false && cachedData.logEntries.length > 0) {
    let meaningful = cachedData.logEntries;

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
  } catch (e) {
    logError(e, 'session-start:lastSession');
  }

  // ============================================================================
  // Output - Hierarchical injection
  // ============================================================================

  // Read handoff from previous session (if recent)
  let handoff = null;
  const lsConfig = sections.lastSession || { enabled: true };
  if (lsConfig.enabled !== false && existsSync(paths.handoff)) {
    try {
      const data = JSON.parse(readFileSync(paths.handoff, 'utf-8'));
      const maxAgeMs = 48 * 60 * 60 * 1000;
      if (data.ts && (Date.now() - new Date(data.ts).getTime()) < maxAgeMs) {
        handoff = data;
      }
    } catch {}
  }

  const hasContent = summaryParts.high || summaryParts.medium ||
                     remembered.length > 0 || gitChanges ||
                     recentEntries.length > 0 || relevantEntities || handoff;

  if (hasContent) {
    console.log(`<claude-mneme project="${escapeAttr(projectName)}">`);

    // Temporal header — session time + last session reference
    const now = new Date();
    const sessionTime = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    let temporalLine = `Session started: ${sessionTime}`;
    if (lastSessionTs) {
      const lastDate = new Date(lastSessionTs);
      const lastFormatted = lastDate.toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
      });
      const diffMin = Math.floor((now - lastDate) / 60000);
      let relative;
      if (diffMin < 2) relative = 'just now';
      else if (diffMin < 60) relative = `${diffMin} minutes ago`;
      else {
        const diffHours = Math.floor(diffMin / 60);
        relative = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
      }
      temporalLine += ` | Last session: ${lastFormatted} (${relative})`;
    }
    if (retrieval) {
      const pct = Math.round(retrieval.signalStrength * 100);
      temporalLine += ` | Context: ${pct}% signal`;
    }
    console.log(`\n${temporalLine}`);

    // HANDOFF from previous session (highest immediate value)
    if (handoff) {
      console.log('\n## Last Session\n');
      if (handoff.workingOn) console.log(`**Working on:** ${handoff.workingOn}`);
      if (handoff.lastDone) console.log(`**Done:** ${handoff.lastDone}`);
      if (handoff.keyInsight) console.log(`**Key insight:** ${handoff.keyInsight}`);
      if (handoff.openItems?.length > 0) {
        console.log(`**Open:** ${handoff.openItems.join(', ')}`);
      }
    }

    // LESSONS LEARNED - high visibility to avoid repeating mistakes
    const lessons = remembered.filter(r => r.type === 'lesson');
    const otherRemembered = remembered.filter(r => r.type !== 'lesson');

    if (lessons.length > 0) {
      console.log('\n## Lessons Learned\n');
      for (const item of lessons) {
        console.log(`- ${item.content}`);
      }
    }

    // HIGH PRIORITY SECTION
    if (summaryParts.high) {
      console.log(summaryParts.high);
    }

    if (otherRemembered.length > 0) {
      console.log('\n## Remembered\n');
      for (const item of otherRemembered) {
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
      const hasClusters = relevantEntities.clusters?.length > 0;
      const hasEntities = hasClusters ||
                          (relevantEntities.files?.length > 0) ||
                          (relevantEntities.functions?.length > 0);
      if (hasEntities) {
        console.log('\n## Recently Active\n');
        const badgeMap = { commit: 'modified', task: 'worked on', prompt: 'discussed', agent: 'worked on', response: 'discussed' };
        const formatEntity = (e) => {
          let line = `\`${e.name}\``;
          const badges = [...new Set((e.contextTypes || []).map(t => badgeMap[t]).filter(Boolean))];
          if (badges.length > 0) line += ` [${badges.join(', ')}]`;
          if (e.velocity) line += ` (${e.velocity})`;
          if (e.recentContext) line += ` — ${e.recentContext}`;
          return `- ${line}`;
        };
        if (hasClusters) {
          for (const cluster of relevantEntities.clusters) {
            const label = cluster.label
              ? cluster.label.charAt(0).toUpperCase() + cluster.label.slice(1)
              : 'Related';
            console.log(`**${label}:**`);
            cluster.entities.forEach(e => console.log(formatEntity(e)));
          }
        }
        if (relevantEntities.files?.length > 0) {
          console.log('**Files:**');
          relevantEntities.files.slice(0, maxFiles).forEach(f => console.log(formatEntity(f)));
        }
        if (relevantEntities.functions?.length > 0) {
          console.log('**Functions:**');
          relevantEntities.functions.slice(0, maxFunctions).forEach(f => console.log(formatEntity(f)));
        }
      }
    }

    // LOW PRIORITY SECTION
    if (recentEntries.length > 0) {
      console.log('\n## Recent Activity\n');
      recentEntries.forEach(entry => console.log(`- ${entry}`));
    }

    // Check for recent errors and warn user
    const recentErrors = getErrorsSince(24);
    if (recentErrors.length > 0) {
      console.log(`\n⚠️ **${recentErrors.length} error(s) in the last 24 hours.** Run \`/status\` to diagnose.`);
    }

    console.log('\nTip: Use /remember to save key decisions, preferences, or project context for future sessions.');
    console.log('</claude-mneme>');
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    logError(err, 'session-start');
    console.error(`[mneme] Error: ${err.message}`);
    process.exit(0); // Exit 0 — memory is non-critical, don't block session startup
  });
