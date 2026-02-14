#!/usr/bin/env node
/**
 * PostToolUse Hook - File Edit and Git Commit Capture
 * Captures file modifications (Write, Edit) and commit messages from Bash git commits
 */

import { appendLogEntry, logError } from './utils.mjs';

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  try {
    const hookData = JSON.parse(input);
    await processToolUse(hookData);
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

  // HEREDOC pattern first — must check before simple -m (which would match the shell wrapper)
  let match = command.match(/<<['"]?EOF['"]?\s*\n\s*([^\n]+)/);
  if (match) {
    return match[1].trim();
  }

  // Simple -m flag patterns (also handles combined flags like -am)
  match = command.match(/git\s+commit\s+[^"']*-[a-z]*m\s*["']([^"']+)["']/);
  if (match) {
    return match[1].trim();
  }

  // --message= pattern
  match = command.match(/git\s+commit\s+[^"']*--message=["']([^"']+)["']/);
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
 * Process Write or Edit tool usage - log the file path
 */
async function processFileEdit(hookData) {
  const { tool_input, cwd } = hookData;

  const filePath = tool_input?.file_path;
  if (!filePath || typeof filePath !== 'string') {
    return false;
  }

  const entry = {
    ts: new Date().toISOString(),
    type: 'edit',
    content: filePath
  };

  await appendLogEntry(entry, cwd || process.cwd());
  return true;
}

/**
 * Process Bash tool usage - only capture git commits
 */
async function processBash(hookData) {
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

  await appendLogEntry(entry, cwd || process.cwd());
  return true;
}

async function processToolUse(hookData) {
  const { tool_name } = hookData;

  if (tool_name === 'Write' || tool_name === 'Edit') {
    await processFileEdit(hookData);
  } else if (tool_name === 'Bash') {
    await processBash(hookData);
  }

  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 5000);
