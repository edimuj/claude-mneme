#!/usr/bin/env node
/**
 * PostToolUse Hook - Task and Git Commit Capture
 * Captures task context from TodoWrite, TaskCreate, TaskUpdate
 * and commit messages from Bash git commits
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ensureMemoryDirs, appendLogEntry, withFileLock, logError } from './utils.mjs';

/**
 * Read the persisted todo hash from disk (survives across process invocations)
 */
function readLastTodoHash(projectDir) {
  const hashPath = join(projectDir, '.last-todo-hash');
  try {
    return existsSync(hashPath) ? readFileSync(hashPath, 'utf-8').trim() : '';
  } catch {
    return '';
  }
}

function writeLastTodoHash(projectDir, hash) {
  try {
    writeFileSync(join(projectDir, '.last-todo-hash'), hash);
  } catch (e) {
    logError(e, 'post-tool-use:writeLastTodoHash');
  }
}

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const hookData = JSON.parse(input);
    processToolUse(hookData);
  } catch (e) {
    logError(e, 'post-tool-use');
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

  // HEREDOC pattern: git commit -m "$(cat <<'EOF'\nmessage\n...\nEOF\n)"
  match = command.match(/<<['"]?EOF['"]?\s*\n\s*([^\n]+)/);
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
  const paths = ensureMemoryDirs(cwd || process.cwd());
  if (todoHash === readLastTodoHash(paths.project)) {
    return false;
  }
  writeLastTodoHash(paths.project, todoHash);

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

  const entry = {
    ts: new Date().toISOString(),
    type: 'task',
    content: parts.join(' ')
  };

  appendLogEntry(entry, cwd || process.cwd());
  return true;
}

/**
 * Read the task subject tracking file
 * Enhanced to track full task lifecycle for outcome tracking
 */
function readTaskTracking(projectDir) {
  const trackingPath = join(projectDir, 'active-tasks.json');
  if (existsSync(trackingPath)) {
    try {
      const data = JSON.parse(readFileSync(trackingPath, 'utf-8'));
      // Migrate old format (simple subjects) to new format (task objects)
      if (data.subjects && typeof Object.values(data.subjects)[0] === 'string') {
        const migrated = { nextId: data.nextId, tasks: {} };
        for (const [id, subject] of Object.entries(data.subjects)) {
          migrated.tasks[id] = { subject, status: 'pending', createdAt: null };
        }
        return migrated;
      }
      return data;
    } catch {
      return { nextId: 1, tasks: {} };
    }
  }
  return { nextId: 1, tasks: {} };
}

/**
 * Write the task subject tracking file
 */
function writeTaskTracking(projectDir, tracking) {
  const trackingPath = join(projectDir, 'active-tasks.json');
  writeFileSync(trackingPath, JSON.stringify(tracking));
}

/**
 * Process TaskCreate tool usage
 * Stores the task with metadata for outcome tracking
 */
function processTaskCreate(hookData) {
  const { tool_input, cwd } = hookData;

  const { subject, description } = tool_input || {};
  if (!subject) {
    return false;
  }

  const paths = ensureMemoryDirs(cwd || process.cwd());
  const taskLockPath = join(paths.project, 'active-tasks.json.lock');
  const result = withFileLock(taskLockPath, () => {
    const tracking = readTaskTracking(paths.project);

    tracking.tasks = tracking.tasks || {};
    const task = {
      subject,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    if (description) task.description = description;
    tracking.tasks[String(tracking.nextId)] = task;
    tracking.nextId++;

    writeTaskTracking(paths.project, tracking);
    return true;
  }, 5);
  return result === true;
}

/**
 * Process TaskUpdate tool usage
 * Tracks task lifecycle and logs meaningful state changes with outcomes
 */
function processTaskUpdate(hookData) {
  const { tool_input, cwd } = hookData;

  const { taskId, status, subject } = tool_input || {};
  if (!taskId) {
    return false;
  }

  const effectiveCwd = cwd || process.cwd();
  const paths = ensureMemoryDirs(effectiveCwd);
  const taskLockPath = join(paths.project, 'active-tasks.json.lock');

  // Collect log entries to append outside the lock (appendLogEntry has its own locking)
  let logEntry = null;

  const result = withFileLock(taskLockPath, () => {
    const tracking = readTaskTracking(paths.project);
    tracking.tasks = tracking.tasks || {};

    const task = tracking.tasks[String(taskId)];

    // Handle deleted tasks - log as abandoned if was in progress
    if (status === 'deleted') {
      if (task && task.status === 'in_progress') {
        logEntry = {
          ts: new Date().toISOString(),
          type: 'task',
          action: 'abandoned',
          outcome: 'abandoned',
          subject: task.subject,
          duration: task.createdAt ? Date.now() - new Date(task.createdAt).getTime() : null
        };
        if (task.description) logEntry.description = task.description;
      }
      delete tracking.tasks[String(taskId)];
      writeTaskTracking(paths.project, tracking);
      return task?.status === 'in_progress';
    }

    // Update task status
    if (task) {
      task.status = status;

      if (status === 'in_progress' && !task.startedAt) {
        task.startedAt = new Date().toISOString();
      }

      if (status === 'completed') {
        const resolvedSubject = subject || task.subject;
        if (!resolvedSubject) return false;

        logEntry = {
          ts: new Date().toISOString(),
          type: 'task',
          action: 'completed',
          outcome: 'completed',
          subject: resolvedSubject,
          duration: task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : null
        };

        delete tracking.tasks[String(taskId)];
        writeTaskTracking(paths.project, tracking);
        return true;
      }

      writeTaskTracking(paths.project, tracking);
    } else {
      tracking.tasks[String(taskId)] = {
        subject: subject || `Task ${taskId}`,
        status: status || 'pending',
        createdAt: new Date().toISOString(),
        startedAt: status === 'in_progress' ? new Date().toISOString() : null
      };
      writeTaskTracking(paths.project, tracking);
    }

    return false;
  }, 5);

  // Append log entry outside the task lock to avoid nested lock contention
  if (logEntry) {
    appendLogEntry(logEntry, effectiveCwd);
  }

  return result === true;
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

  const entry = {
    ts: new Date().toISOString(),
    type: 'commit',
    content: message
  };

  appendLogEntry(entry, cwd || process.cwd());
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
