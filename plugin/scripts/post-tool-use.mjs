#!/usr/bin/env node
/**
 * PostToolUse Hook - Task and Git Commit Capture
 * Captures task context from TodoWrite, TaskCreate, TaskUpdate
 * and commit messages from Bash git commits
 */

import { appendFileSync } from 'fs';
import { ensureMemoryDirs, maybeSummarize } from './utils.mjs';

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

/**
 * Extract commit message from git commit command
 */
function extractCommitMessage(command) {
  if (!command || typeof command !== 'string') {
    return null;
  }

  // Match various git commit patterns
  // git commit -m "message"
  // git commit -m 'message'
  // git commit -am "message"
  // git commit --message="message"
  // HEREDOC style: git commit -m "$(cat <<'EOF'\nmessage\nEOF\n)"

  // Simple -m flag patterns
  let match = command.match(/git\s+commit\s+[^"']*-m\s*["']([^"']+)["']/);
  if (match) {
    return match[1].trim();
  }

  // --message= pattern
  match = command.match(/git\s+commit\s+[^"']*--message=["']([^"']+)["']/);
  if (match) {
    return match[1].trim();
  }

  // HEREDOC pattern - extract first line of the message
  match = command.match(/git\s+commit.*<<['"]?EOF['"]?\s*\n([^\n]+)/);
  if (match) {
    return match[1].trim();
  }

  // Fallback: try to find any quoted string after commit
  match = command.match(/git\s+commit.*["']([^"']{10,})["']/);
  if (match) {
    return match[1].trim();
  }

  return null;
}

/**
 * Process TodoWrite tool usage
 */
function processTodoWrite(hookData) {
  const { tool_input, cwd } = hookData;

  const todos = tool_input?.todos;
  if (!todos || !Array.isArray(todos) || todos.length === 0) {
    return false;
  }

  // Extract meaningful task info
  const inProgress = todos.filter(t => t.status === 'in_progress').map(t => t.content);
  const completed = todos.filter(t => t.status === 'completed').map(t => t.content);
  const pending = todos.filter(t => t.status === 'pending').map(t => t.content);

  // Create a hash to detect significant changes
  const todoHash = JSON.stringify({ inProgress, completed: completed.length, pending: pending.length });

  // Only log if there's a meaningful change (new in_progress task or completions)
  if (todoHash === lastTodoHash) {
    return false;
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
    return false;
  }

  // Get project-specific paths
  const paths = ensureMemoryDirs(cwd || process.cwd());

  const entry = {
    ts: new Date().toISOString(),
    type: 'task',
    content: parts.join(' ')
  };

  appendFileSync(paths.log, JSON.stringify(entry) + '\n');
  maybeSummarize(cwd || process.cwd());
  return true;
}

/**
 * Process TaskCreate tool usage
 */
function processTaskCreate(hookData) {
  const { tool_input, cwd } = hookData;

  const { subject, description } = tool_input || {};
  if (!subject) {
    return false;
  }

  // Get project-specific paths
  const paths = ensureMemoryDirs(cwd || process.cwd());

  const entry = {
    ts: new Date().toISOString(),
    type: 'task',
    content: `Task created: ${subject}`
  };

  appendFileSync(paths.log, JSON.stringify(entry) + '\n');
  maybeSummarize(cwd || process.cwd());
  return true;
}

/**
 * Process TaskUpdate tool usage
 */
function processTaskUpdate(hookData) {
  const { tool_input, cwd } = hookData;

  const { taskId, status, subject } = tool_input || {};
  if (!taskId) {
    return false;
  }

  // Only log meaningful status changes
  if (!status && !subject) {
    return false;
  }

  // Get project-specific paths
  const paths = ensureMemoryDirs(cwd || process.cwd());

  let content;
  if (status === 'in_progress') {
    content = `Task started: ${subject || `#${taskId}`}`;
  } else if (status === 'completed') {
    content = `Task completed: ${subject || `#${taskId}`}`;
  } else if (subject) {
    content = `Task updated: ${subject}`;
  } else {
    return false;
  }

  const entry = {
    ts: new Date().toISOString(),
    type: 'task',
    content
  };

  appendFileSync(paths.log, JSON.stringify(entry) + '\n');
  maybeSummarize(cwd || process.cwd());
  return true;
}

/**
 * Process Bash tool usage - only capture git commits
 */
function processBash(hookData) {
  const { tool_input, cwd } = hookData;

  const command = tool_input?.command;
  if (!command || typeof command !== 'string') {
    return false;
  }

  // Only capture git commit commands
  if (!command.includes('git') || !command.includes('commit')) {
    return false;
  }

  // More specific check - must be a git commit command
  if (!/git\s+commit/.test(command)) {
    return false;
  }

  const commitMessage = extractCommitMessage(command);
  if (!commitMessage) {
    return false;
  }

  // Truncate very long commit messages
  let message = commitMessage;
  if (message.length > 200) {
    message = message.substring(0, 200) + '...';
  }

  // Get project-specific paths
  const paths = ensureMemoryDirs(cwd || process.cwd());

  const entry = {
    ts: new Date().toISOString(),
    type: 'commit',
    content: `Git commit: ${message}`
  };

  appendFileSync(paths.log, JSON.stringify(entry) + '\n');
  maybeSummarize(cwd || process.cwd());
  return true;
}

function processToolUse(hookData) {
  const { tool_name } = hookData;

  if (tool_name === 'TodoWrite') {
    processTodoWrite(hookData);
  } else if (tool_name === 'TaskCreate') {
    processTaskCreate(hookData);
  } else if (tool_name === 'TaskUpdate') {
    processTaskUpdate(hookData);
  } else if (tool_name === 'Bash') {
    processBash(hookData);
  }

  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 5000);
