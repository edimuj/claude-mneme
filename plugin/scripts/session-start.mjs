#!/usr/bin/env node
/**
 * Session Start Hook
 * Reads project-specific memory context and outputs it for injection
 */

import { readFileSync, existsSync } from 'fs';
import { ensureMemoryDirs, loadConfig, getProjectName } from './utils.mjs';

const cwd = process.cwd();
const paths = ensureMemoryDirs(cwd);
const config = loadConfig();
const projectName = getProjectName(cwd);

// Read summary
let summary = '';
if (existsSync(paths.summary)) {
  summary = readFileSync(paths.summary, 'utf-8').trim();
}

// Read recent log entries
let recentEntries = [];
if (existsSync(paths.log)) {
  try {
    const content = readFileSync(paths.log, 'utf-8').trim();
    if (content) {
      const lines = content.split('\n').filter(l => l);
      const recent = lines.slice(-config.keepRecentEntries);
      recentEntries = recent.map(line => {
        try {
          const entry = JSON.parse(line);
          return `[${entry.ts}] (${entry.type}) ${entry.content}`;
        } catch {
          return null;
        }
      }).filter(Boolean);
    }
  } catch {
    // Ignore read errors
  }
}

// Output memory context if we have any
if (summary || recentEntries.length > 0) {
  console.log(`<claude-mneme project="${projectName}">`);
  if (summary) {
    console.log(summary);
  }
  if (recentEntries.length > 0) {
    console.log('\n## Recent Memory Entries\n');
    recentEntries.forEach(entry => console.log(`- ${entry}`));
  }
  console.log('</claude-mneme>');
}

process.exit(0);
