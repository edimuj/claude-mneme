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
import { ensureMemoryDirs, getProjectName, invalidateCache, logError } from './utils.mjs';

const cwd = process.cwd();
const paths = ensureMemoryDirs(cwd);
const projectName = getProjectName(cwd);

const VALID_TYPES = ['fact', 'project', 'preference', 'note'];

const args = process.argv.slice(2);
const type = args[0] || 'note';
const content = args.slice(1).join(' ');

if (!content) {
  console.error('Usage: node mem-add.mjs <type> <content>');
  console.error(`Types: ${VALID_TYPES.join(', ')}`);
  process.exit(1);
}

if (!VALID_TYPES.includes(type)) {
  console.error(`Invalid type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`);
  process.exit(1);
}

// Read existing entries
let entries = [];
if (existsSync(paths.remembered)) {
  try {
    entries = JSON.parse(readFileSync(paths.remembered, 'utf-8'));
  } catch (e) {
    logError(e, 'mem-add:remembered.json');
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
invalidateCache(cwd);
console.log(`Remembered for "${projectName}": [${type}] ${content}`);
