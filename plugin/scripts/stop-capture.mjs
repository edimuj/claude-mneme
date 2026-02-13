#!/usr/bin/env node
/**
 * Stop Hook - Response Capture
 * Captures Claude's final response when a turn completes
 * Supports configurable summarization: none, extractive, or llm
 *
 * Handles markdown formatting:
 * - Splits on paragraph breaks (double newlines)
 * - Treats bullet list items as separate units
 * - Falls back to sentence boundary detection
 *
 * Runs before session-stop.mjs (summarization)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { ensureMemoryDirs, loadConfig, appendLogEntry, extractiveSummarize, stripMarkdown, logError } from './utils.mjs';
import { homedir } from 'os';
import { join } from 'path';

const DEBUG_LOG = join(homedir(), '.claude-mneme', 'debug-stop-capture.log');
function debugLog(msg) {
  appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
}

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  debugLog(`INVOKED. stdin length: ${input.length}`);
  try {
    const hookData = JSON.parse(input);
    debugLog(`hookData keys: ${Object.keys(hookData).join(', ')}`);
    debugLog(`transcript_path: ${hookData.transcript_path || 'MISSING'}`);
    debugLog(`cwd: ${hookData.cwd || 'MISSING'}`);
    await processStop(hookData);
  } catch (e) {
    debugLog(`ERROR: ${e.message}`);
    logError(e, 'stop-capture');
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

/**
 * Extract text content from a message content field (string or content blocks)
 */
function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

const CONFIRMATION_PATTERN = /^(y(es)?|no?|ok(ay)?|sure|go ahead|continue|do it|sounds good|lgtm|looks good|please|yep|yup|nope|correct|right|exactly|agreed|confirmed?)\.?$/i;

function isConfirmation(text) {
  return text.trim().length < 20 || CONFIRMATION_PATTERN.test(text.trim());
}

/**
 * Extract open items / next steps from assistant text
 */
function extractOpenItems(text) {
  if (!text) return [];
  const items = [];
  const patterns = [
    /(?:next steps?|todo|remaining|still need to|should|need to|plan to)[:\s]+(.+)/gi,
    /(?:^|\n)\s*[-*]\s*\[[ ]\]\s*(.+)/gm,  // unchecked markdown checkboxes
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const item = match[1].trim().substring(0, 150);
      if (item.length >= 10 && items.length < 5) {
        items.push(item);
      }
    }
  }
  return items;
}

/**
 * Build handoff data from transcript for next session pickup
 */
function extractHandoff(transcript, responseSummary) {
  // Find last meaningful user prompt (walk backward, skip confirmations)
  let workingOn = null;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === 'user') {
      const text = extractTextContent(transcript[i].content);
      if (text && text.length >= 20 && !isConfirmation(text)) {
        workingOn = text.substring(0, 300);
        break;
      }
    }
  }

  // Get open items from last assistant response
  let lastAssistantText = '';
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === 'assistant') {
      lastAssistantText = extractTextContent(transcript[i].content);
      break;
    }
  }

  return {
    ts: new Date().toISOString(),
    workingOn,
    lastDone: responseSummary || null,
    openItems: extractOpenItems(lastAssistantText),
  };
}

/**
 * Read last N lines from a file efficiently (tail of file only)
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

/**
 * Check if the last response entry already has identical content.
 * Prevents duplicate logging when Stop fires but the transcript's last
 * assistant message hasn't changed (e.g. current turn used a subagent).
 */
function isDuplicateResponse(content, logPath) {
  const pendingPath = logPath.replace('.jsonl', '.pending.jsonl');
  const filesToCheck = [pendingPath, logPath].filter(f => existsSync(f));
  const prefix = content.substring(0, 100).toLowerCase();

  for (const filePath of filesToCheck) {
    const lastLines = readLastLines(filePath, 5);
    for (const line of lastLines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'response') {
          const existing = (entry.content || '').substring(0, 100).toLowerCase();
          if (prefix === existing || prefix.startsWith(existing) || existing.startsWith(prefix)) {
            return true;
          }
        }
      } catch {}
    }
  }
  return false;
}

async function processStop(hookData) {
  const { transcript_path, cwd } = hookData;

  // Read transcript from file path (Claude Code passes path, not data)
  const transcript = readTranscript(transcript_path);

  if (!transcript || transcript.length === 0) {
    debugLog(`EXIT: no transcript (path: ${transcript_path}, exists: ${transcript_path ? existsSync(transcript_path) : 'N/A'})`);
    process.exit(0);
    return;
  }
  debugLog(`transcript entries: ${transcript.length}`);

  // Find the last assistant message in the transcript
  let lastAssistantMessage = null;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === 'assistant') {
      lastAssistantMessage = transcript[i];
      break;
    }
  }

  if (!lastAssistantMessage) {
    debugLog('EXIT: no assistant message found');
    process.exit(0);
    return;
  }

  // Extract text content from the assistant message
  const textContent = extractTextContent(lastAssistantMessage.content);

  if (!textContent || textContent.trim().length === 0) {
    debugLog(`EXIT: empty textContent (content type: ${typeof lastAssistantMessage.content}, isArray: ${Array.isArray(lastAssistantMessage.content)})`);
    process.exit(0);
    return;
  }
  debugLog(`textContent length: ${textContent.length}, first 80: ${textContent.substring(0, 80)}`);

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
  let processed = stripMarkdown(textContent);

  // Apply response summarization based on configured mode
  const mode = config.responseSummarization || 'none';
  if (mode === 'extractive') {
    processed = extractiveSummarize(processed, config);
  }
  // 'llm' mode: reserved for future LLM-based summarization
  // 'none': no summarization, just length cap below

  // Apply max length truncation as final safeguard
  if (processed.length > config.maxResponseLength) {
    processed = processed.substring(0, config.maxResponseLength) + '...';
  }

  const workDir = cwd || process.cwd();
  const paths = ensureMemoryDirs(workDir);

  // Skip if the last response entry already has identical content
  // (happens when Stop fires but transcript's last assistant msg is stale,
  // e.g. current turn used a subagent whose output came via tool result)
  if (isDuplicateResponse(processed, paths.log)) {
    debugLog('EXIT: duplicate response detected');
    process.exit(0);
    return;
  }

  const entry = {
    ts: new Date().toISOString(),
    type: 'response',
    content: processed
  };

  debugLog(`WRITING entry: ${JSON.stringify(entry).substring(0, 200)}`);
  await appendLogEntry(entry, workDir);
  debugLog('DONE: entry written');

  // Write handoff for next session pickup
  try {
    const handoff = extractHandoff(transcript, processed);
    writeFileSync(paths.handoff, JSON.stringify(handoff, null, 2));
  } catch (e) {
    logError(e, 'stop-capture:handoff');
  }

  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 10000);
