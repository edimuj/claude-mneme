#!/usr/bin/env node
/**
 * SubagentStop Hook - Agent Completion Capture
 * Captures summaries from specialized agents when they complete tasks
 * These are high-signal entries about complex work performed
 *
 * Note: Claude Code passes transcript_path (file path), not direct output
 */

import { appendFileSync, readFileSync, existsSync } from 'fs';
import { ensureMemoryDirs } from './utils.mjs';

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    // DEBUG: Write raw hook data to file to see what Claude Code sends
    appendFileSync('/tmp/subagent-stop-debug.json', input + '\n---\n');

    const hookData = JSON.parse(input);
    processSubagentStop(hookData);
  } catch (e) {
    // DEBUG: Log errors too
    appendFileSync('/tmp/subagent-stop-debug.json', `ERROR: ${e.message}\n---\n`);
    process.exit(0);
  }
});

/**
 * Read and parse transcript from transcript_path
 * Claude Code provides transcript as a JSONL file path, not direct data
 */
function readTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return null;
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    // Parse JSONL - each line is a JSON object
    const lines = content.split('\n').filter(l => l.trim());
    const transcript = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' || entry.type === 'assistant') {
          transcript.push({
            role: entry.type,
            content: entry.message?.content || entry.content
          });
        }
      } catch {
        // Skip malformed lines
      }
    }

    return transcript.length > 0 ? transcript : null;
  } catch {
    return null;
  }
}

/**
 * Extract text content from transcript message
 */
function extractTextContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

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
  const { agent_type, task_description, transcript_path, cwd } = hookData;

  // Read transcript from file path (Claude Code passes path, not direct data)
  const transcript = readTranscript(transcript_path);

  if (!transcript || transcript.length === 0) {
    process.exit(0);
    return;
  }

  // Find the last assistant message (the agent's final output)
  let lastAssistantMessage = null;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === 'assistant') {
      lastAssistantMessage = transcript[i];
      break;
    }
  }

  if (!lastAssistantMessage) {
    process.exit(0);
    return;
  }

  const output = extractTextContent(lastAssistantMessage.content);
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
