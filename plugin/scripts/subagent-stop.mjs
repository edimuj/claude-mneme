#!/usr/bin/env node
/**
 * SubagentStop Hook - Agent Completion Capture
 * Captures summaries from specialized agents when they complete tasks
 * These are high-signal entries about complex work performed
 *
 * Note: Claude Code passes transcript_path (file path), not direct output
 */

import { appendFileSync, readFileSync, existsSync } from 'fs';
import { ensureMemoryDirs, loadConfig, maybeSummarize, extractiveSummarize } from './utils.mjs';

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
 * Check if a very recent response entry already covers the same content.
 * Prevents duplicate logging when both stop-capture and subagent-stop fire.
 */
function isDuplicateOfRecentResponse(content, logPath) {
  if (!existsSync(logPath)) return false;
  try {
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const now = Date.now();
    for (const line of lines.slice(-3)) {
      const entry = JSON.parse(line);
      if (entry.type === 'response' && (now - new Date(entry.ts).getTime()) < 30000) {
        const a = content.substring(0, 100).toLowerCase();
        const b = (entry.content || '').substring(0, 100).toLowerCase();
        if (a === b || a.startsWith(b) || b.startsWith(a)) {
          return true;
        }
      }
    }
  } catch {}
  return false;
}

function processSubagentStop(hookData) {
  const { agent_type, task_description, transcript_path, cwd } = hookData;

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

  const agentName = agent_type || 'agent';
  const config = loadConfig();
  const paths = ensureMemoryDirs(cwd || process.cwd());

  // Use shared extractive summarization (with lead-in stripping)
  const summary = extractiveSummarize(output, config);

  if (!summary) {
    process.exit(0);
    return;
  }

  // Build content, include task description if short
  const parts = [];
  if (task_description && task_description.length < 50) {
    parts.push(`${task_description}:`);
  }
  parts.push(summary);
  const content = parts.join(' ');

  // Skip if a recent response entry already covers the same content
  if (isDuplicateOfRecentResponse(content, paths.log)) {
    process.exit(0);
    return;
  }

  const entry = {
    ts: new Date().toISOString(),
    type: 'agent',
    agent_type: agentName,
    content
  };

  appendFileSync(paths.log, JSON.stringify(entry) + '\n');
  maybeSummarize(cwd || process.cwd());

  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 5000);
