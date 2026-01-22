#!/usr/bin/env node
/**
 * Add a memory entry to the project-specific log
 * Usage: node mem-add.mjs <type> <content>
 * Types: fact, project, preference, session, note
 */

import { appendFileSync } from 'fs';
import { ensureMemoryDirs, getProjectName } from './utils.mjs';

const cwd = process.cwd();
const paths = ensureMemoryDirs(cwd);
const projectName = getProjectName(cwd);

const args = process.argv.slice(2);
const type = args[0] || 'note';
const content = args.slice(1).join(' ');

if (!content) {
  console.error('Usage: node mem-add.mjs <type> <content>');
  console.error('Types: fact, project, preference, session, note');
  process.exit(1);
}

const entry = {
  ts: new Date().toISOString(),
  type,
  content
};

appendFileSync(paths.log, JSON.stringify(entry) + '\n');
console.log(`Memory logged for "${projectName}": [${type}] ${content}`);
