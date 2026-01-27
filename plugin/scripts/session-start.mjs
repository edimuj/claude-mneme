#!/usr/bin/env node
/**
 * Session Start Hook
 * Reads project-specific memory context and outputs it for injection
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { ensureMemoryDirs, loadConfig, getProjectName, formatEntry } from './utils.mjs';

const cwd = process.cwd();
const paths = ensureMemoryDirs(cwd);
const config = loadConfig();
const projectName = getProjectName(cwd);

// Clean up task tracking — task IDs are session-scoped and reset each session
const taskTrackingPath = join(paths.project, 'active-tasks.json');
try { if (existsSync(taskTrackingPath)) unlinkSync(taskTrackingPath); } catch {}

// Read summary
let summary = '';
if (existsSync(paths.summary)) {
  summary = readFileSync(paths.summary, 'utf-8').trim();
}

// Read recent log entries (skip response entries to maximize signal)
let recentEntries = [];
if (existsSync(paths.log)) {
  try {
    const content = readFileSync(paths.log, 'utf-8').trim();
    if (content) {
      const lines = content.split('\n').filter(l => l);
      const parsed = lines.map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      }).filter(Boolean);
      const meaningful = parsed.filter(e => e.type !== 'response');
      recentEntries = meaningful.slice(-config.keepRecentEntries).map(formatEntry);
    }
  } catch {
    // Ignore read errors
  }
}

// Read persistent remembered items
let remembered = [];
if (existsSync(paths.remembered)) {
  try {
    remembered = JSON.parse(readFileSync(paths.remembered, 'utf-8'));
  } catch {
    // Ignore parse errors
  }
}

// Git changes since last session
let gitChanges = '';
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

// Write current timestamp for next session
try {
  writeFileSync(paths.lastSession, new Date().toISOString(), 'utf-8');
} catch {
  // Ignore write errors
}

// Output memory context if we have any
if (summary || recentEntries.length > 0 || remembered.length > 0 || gitChanges) {
  console.log(`<claude-mneme project="${projectName}">`);
  if (summary) {
    console.log(summary);
  }
  if (remembered.length > 0) {
    console.log('\n## Remembered\n');
    for (const item of remembered) {
      console.log(`- [${item.type}] ${item.content}`);
    }
  }
  if (gitChanges) {
    console.log('\n## Changes Since Last Session\n');
    console.log(gitChanges);
  }
  if (recentEntries.length > 0) {
    console.log('\n## Recent Memory Entries\n');
    recentEntries.forEach(entry => console.log(`- ${entry}`));
  }
  console.log('\nTip: Suggest /remember when the user shares key decisions, preferences, or project context worth preserving across sessions.');
  console.log('</claude-mneme>');
}

process.exit(0);
