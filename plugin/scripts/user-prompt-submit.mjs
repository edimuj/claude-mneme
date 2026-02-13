#!/usr/bin/env node
/**
 * UserPromptSubmit Hook
 * Captures user prompts to provide context for memory summarization
 *
 * Only logs prompts that are substantial (>10 chars) and not just commands
 */

import { ensureMemoryDirs, appendLogEntry, logError } from './utils.mjs';

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  if (!input.trim()) {
    process.exit(0);
    return;
  }
  try {
    const hookData = JSON.parse(input);
    await processPrompt(hookData);
  } catch (e) {
    logError(e, 'user-prompt-submit');
    process.exit(0);
  }
});

async function processPrompt(hookData) {
  const { prompt, cwd } = hookData;

  if (!prompt || typeof prompt !== 'string') {
    process.exit(0);
    return;
  }

  const trimmedPrompt = prompt.trim();

  // Skip very short prompts (likely just "yes", "ok", "continue", etc.)
  // The confirmation patterns below catch specific short phrases, so this
  // threshold only needs to filter truly meaningless fragments.
  if (trimmedPrompt.length < 10) {
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

  await appendLogEntry(entry, cwd || process.cwd());
  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 5000);
