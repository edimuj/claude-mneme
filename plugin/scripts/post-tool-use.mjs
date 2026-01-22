#!/usr/bin/env node
/**
 * PostToolUse Hook - TodoWrite Only
 * Captures task context from TodoWrite to provide visibility into work being done
 */

import { appendFileSync } from 'fs';
import { ensureMemoryDirs } from './utils.mjs';

// Track last logged todos to avoid duplicates
let lastTodoHash = '';

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const hookData = JSON.parse(input);
    processToolUse(hookData);
  } catch (e) {
    // Silent fail - don't block Claude Code
    process.exit(0);
  }
});

function processToolUse(hookData) {
  const { tool_name, tool_input, cwd } = hookData;

  // Only capture TodoWrite
  if (tool_name !== 'TodoWrite') {
    process.exit(0);
    return;
  }

  const todos = tool_input?.todos;
  if (!todos || !Array.isArray(todos) || todos.length === 0) {
    process.exit(0);
    return;
  }

  // Extract meaningful task info
  const inProgress = todos.filter(t => t.status === 'in_progress').map(t => t.content);
  const completed = todos.filter(t => t.status === 'completed').map(t => t.content);
  const pending = todos.filter(t => t.status === 'pending').map(t => t.content);

  // Create a hash to detect significant changes
  const todoHash = JSON.stringify({ inProgress, completed: completed.length, pending: pending.length });

  // Only log if there's a meaningful change (new in_progress task or completions)
  if (todoHash === lastTodoHash) {
    process.exit(0);
    return;
  }
  lastTodoHash = todoHash;

  // Build content focusing on what's being worked on
  const parts = [];
  if (inProgress.length > 0) {
    parts.push(`Working on: ${inProgress.join(', ')}`);
  }
  if (completed.length > 0 && pending.length > 0) {
    parts.push(`(${completed.length} done, ${pending.length} remaining)`);
  }

  if (parts.length === 0) {
    process.exit(0);
    return;
  }

  // Get project-specific paths
  const paths = ensureMemoryDirs(cwd || process.cwd());

  const entry = {
    ts: new Date().toISOString(),
    type: 'task',
    content: parts.join(' ')
  };

  appendFileSync(paths.log, JSON.stringify(entry) + '\n');
  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 5000);
