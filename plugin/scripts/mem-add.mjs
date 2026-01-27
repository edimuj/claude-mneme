#!/usr/bin/env node
/**
 * Add a memory entry to the project's persistent remembered.json
 * Usage: node mem-add.mjs <type> <content>
 * Types: fact, project, preference, note
 *
 * Unlike log.jsonl entries, remembered items are never summarized away.
 * Users must manually remove entries they no longer need.
 */

import { readFileSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import { ensureMemoryDirs, getProjectName } from './utils.mjs';

const cwd = process.cwd();
const paths = ensureMemoryDirs(cwd);
const projectName = getProjectName(cwd);

const args = process.argv.slice(2);
const type = args[0] || 'note';
const content = args.slice(1).join(' ');

if (!content) {
  console.error('Usage: node mem-add.mjs <type> <content>');
  console.error('Types: fact, project, preference, note');
  process.exit(1);
}

// Read existing entries
let entries = [];
if (existsSync(paths.remembered)) {
  try {
    entries = JSON.parse(readFileSync(paths.remembered, 'utf-8'));
  } catch {
    entries = [];
  }
}

// Add new entry
entries.push({
  ts: new Date().toISOString(),
  type,
  content
});

writeFileSync(paths.remembered, JSON.stringify(entries, null, 2) + '\n');
console.log(`Remembered for "${projectName}": [${type}] ${content}`);
