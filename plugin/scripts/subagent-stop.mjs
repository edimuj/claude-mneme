#!/usr/bin/env node
/**
 * SubagentStop Hook - Agent Completion Capture
 * Captures summaries from specialized agents when they complete tasks
 * These are high-signal entries about complex work performed
 *
 * Note: Claude Code passes transcript_path (file path), not direct output
 */

import { readFileSync, existsSync, openSync, readSync, closeSync, statSync } from 'fs';
import { ensureMemoryDirs, loadConfig, appendLogEntry, extractiveSummarize, stripLeadIns, stripMarkdown, logError } from './utils.mjs';

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const hookData = JSON.parse(input);
    processSubagentStop(hookData);
  } catch (e) {
    logError(e, 'subagent-stop');
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
 * Checks both main log and pending file.
 */
function readLastLines(filePath, count) {
  try {
    const stat = statSync(filePath);
    if (stat.size === 0) return [];
    const readSize = Math.min(stat.size, 4096);
    const buf = Buffer.alloc(readSize);
    const fd = openSync(filePath, 'r');
    readSync(fd, buf, 0, readSize, stat.size - readSize);
    closeSync(fd);
    const lines = buf.toString('utf-8').trim().split('\n');
    return lines.slice(-count);
  } catch {
    return [];
  }
}

function isDuplicateOfRecentResponse(content, logPath) {
  const pendingPath = logPath.replace('.jsonl', '.pending.jsonl');
  const filesToCheck = [logPath, pendingPath].filter(f => existsSync(f));

  const now = Date.now();
  for (const filePath of filesToCheck) {
    // Read only the tail of the file (last ~4KB) instead of the entire log
    const lastLines = readLastLines(filePath, 3);
    for (const line of lastLines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'response' && (now - new Date(entry.ts).getTime()) < 30000) {
          const a = content.substring(0, 100).toLowerCase();
          const b = (entry.content || '').substring(0, 100).toLowerCase();
          if (a === b || a.startsWith(b) || b.startsWith(a)) {
            return true;
          }
        }
      } catch {}
    }
  }
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

  const rawOutput = extractTextContent(lastAssistantMessage.content);
  if (!rawOutput || !rawOutput.trim()) {
    process.exit(0);
    return;
  }

  const output = stripMarkdown(rawOutput);
  const agentName = agent_type || 'agent';
  const config = loadConfig();
  const paths = ensureMemoryDirs(cwd || process.cwd());

  // Summarize agent output based on configured mode
  // Subagent output is typically verbose — extractive is a sensible minimum
  const mode = config.responseSummarization || 'none';
  const summary = (mode === 'none')
    ? stripLeadIns(output)
    : extractiveSummarize(output, config);

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
  let content = parts.join(' ');

  // Apply max length truncation as final safeguard
  if (content.length > config.maxResponseLength) {
    content = content.substring(0, config.maxResponseLength) + '...';
  }

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

  appendLogEntry(entry, cwd || process.cwd());
  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 5000);
