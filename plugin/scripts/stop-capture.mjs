#!/usr/bin/env node
/**
 * Stop Hook - Response Capture
 * Captures Claude's final response when a turn completes
 * Uses extractive summarization to keep log entries concise
 *
 * Handles markdown formatting:
 * - Splits on paragraph breaks (double newlines)
 * - Treats bullet list items as separate units
 * - Falls back to sentence boundary detection
 *
 * Runs before session-stop.mjs (summarization)
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
    processStop(hookData);
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
        // Transcript entries have role and message properties
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

function processStop(hookData) {
  const { transcript_path, cwd } = hookData;

  // Read transcript from file path (Claude Code passes path, not data)
  const transcript = readTranscript(transcript_path);

  if (!transcript || transcript.length === 0) {
    process.exit(0);
    return;
  }

  // Find the last assistant message in the transcript
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

  // Extract text content from the assistant message
  const content = lastAssistantMessage.content;
  let textContent = '';

  if (typeof content === 'string') {
    textContent = content;
  } else if (Array.isArray(content)) {
    // Content blocks - extract text blocks only
    textContent = content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }

  if (!textContent || textContent.trim().length === 0) {
    process.exit(0);
    return;
  }

  // Skip /remember command responses (already persisted in remembered.json)
  const rememberPatterns = [
    /what would you like me to remember/i,
    /remembered\.json/,
    /this will persist across all future sessions/i,
  ];
  if (rememberPatterns.some(p => p.test(textContent))) {
    process.exit(0);
    return;
  }

  const config = loadConfig();
  let processed = textContent.trim();

  // Apply extractive summarization if enabled
  if (config.summarizeResponses) {
    processed = extractiveSummarize(processed, config);
  }

  // Apply max length truncation as final safeguard
  if (processed.length > config.maxResponseLength) {
    processed = processed.substring(0, config.maxResponseLength) + '...';
  }

  // Get project-specific paths
  const paths = ensureMemoryDirs(cwd || process.cwd());

  const entry = {
    ts: new Date().toISOString(),
    type: 'response',
    content: processed
  };

  appendFileSync(paths.log, JSON.stringify(entry) + '\n');

  // Check if summarization is needed
  maybeSummarize(cwd || process.cwd());

  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 5000);
