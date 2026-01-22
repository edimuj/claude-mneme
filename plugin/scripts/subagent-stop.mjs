#!/usr/bin/env node
/**
 * SubagentStop Hook - Agent Completion Capture
 * Captures summaries from specialized agents when they complete tasks
 * These are high-signal entries about complex work performed
 */

import { appendFileSync } from 'fs';
import { ensureMemoryDirs } from './utils.mjs';

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const hookData = JSON.parse(input);
    processSubagentStop(hookData);
  } catch (e) {
    // Silent fail - don't block Claude Code
    process.exit(0);
  }
});

/**
 * Extract a concise summary from agent output
 * Focuses on the first few meaningful sentences
 */
function extractAgentSummary(output, maxLength = 300) {
  if (!output || typeof output !== 'string') {
    return null;
  }

  // Clean up the output
  let text = output.trim();

  // Remove common prefixes/noise
  text = text.replace(/^(I've |I have |I |The agent |Agent )/i, '');

  // Get first paragraph or first few sentences
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
  if (paragraphs.length > 0) {
    text = paragraphs[0];
  }

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // Truncate if too long
  if (text.length > maxLength) {
    // Try to cut at sentence boundary
    const truncated = text.substring(0, maxLength);
    const lastSentence = truncated.lastIndexOf('. ');
    if (lastSentence > maxLength * 0.5) {
      text = truncated.substring(0, lastSentence + 1);
    } else {
      text = truncated + '...';
    }
  }

  return text;
}

function processSubagentStop(hookData) {
  const { agent_type, task_description, output, cwd } = hookData;

  // Skip if no meaningful output
  if (!output || !output.trim()) {
    process.exit(0);
    return;
  }

  // Extract agent name for context
  const agentName = agent_type || 'agent';

  // Extract a concise summary from the output
  const summary = extractAgentSummary(output);

  if (!summary) {
    process.exit(0);
    return;
  }

  // Build the memory entry
  const parts = [];

  // Include task description if available and short
  if (task_description && task_description.length < 50) {
    parts.push(`[${agentName}] ${task_description}:`);
  } else {
    parts.push(`[${agentName}]`);
  }

  parts.push(summary);

  // Get project-specific paths
  const paths = ensureMemoryDirs(cwd || process.cwd());

  const entry = {
    ts: new Date().toISOString(),
    type: 'agent',
    content: parts.join(' ')
  };

  appendFileSync(paths.log, JSON.stringify(entry) + '\n');
  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 5000);
