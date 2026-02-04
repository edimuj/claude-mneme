#!/usr/bin/env node
/**
 * UserPromptSubmit Hook
 * Captures user prompts to provide context for memory summarization
 *
 * Only logs prompts that are substantial (>20 chars) and not just commands
 */

import { ensureMemoryDirs, appendLogEntry } from './utils.mjs';

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const hookData = JSON.parse(input);
    processPrompt(hookData);
  } catch (e) {
    // Silent fail - don't block Claude Code
    process.exit(0);
  }
});

function processPrompt(hookData) {
  const { prompt, cwd } = hookData;

  if (!prompt || typeof prompt !== 'string') {
    process.exit(0);
    return;
  }

  const trimmedPrompt = prompt.trim();

  // Skip very short prompts (likely just "yes", "ok", "continue", etc.)
  if (trimmedPrompt.length < 20) {
    process.exit(0);
    return;
  }

  // Skip slash commands (they're logged elsewhere or not meaningful for memory)
  if (trimmedPrompt.startsWith('/')) {
    process.exit(0);
    return;
  }

  // Skip prompts that are just confirmations
  const confirmationPatterns = [
    /^(yes|no|ok|okay|sure|yep|nope|y|n)[\s.,!?]*$/i,
    /^(continue|proceed|go ahead|do it|sounds good)[\s.,!?]*$/i,
    /^(thanks|thank you|thx)[\s.,!?]*$/i,
  ];

  if (confirmationPatterns.some(p => p.test(trimmedPrompt))) {
    process.exit(0);
    return;
  }

  // Truncate very long prompts to first 500 chars
  const content = trimmedPrompt.length > 500
    ? trimmedPrompt.substring(0, 500) + '...'
    : trimmedPrompt;

  const entry = {
    ts: new Date().toISOString(),
    type: 'prompt',
    content
  };

  appendLogEntry(entry, cwd || process.cwd());
  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 5000);
