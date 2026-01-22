#!/usr/bin/env node
/**
 * Stop Hook - Response Capture
 * Captures Claude's final response when a turn completes
 * Uses extractive summarization to keep log entries concise
 *
 * Runs before session-stop.mjs (summarization)
 */

import { appendFileSync } from 'fs';
import { ensureMemoryDirs, loadConfig } from './utils.mjs';

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
 * Split text into sentences
 * Handles common abbreviations and edge cases
 */
function splitSentences(text) {
  // Normalize whitespace
  const normalized = text.replace(/\s+/g, ' ').trim();

  // Split on sentence boundaries, being careful with abbreviations
  const sentences = [];
  let current = '';

  // Simple regex-based split - handles most cases
  const parts = normalized.split(/(?<=[.!?])\s+(?=[A-Z])/);

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      sentences.push(trimmed);
    }
  }

  // If no splits found, return the whole text as one sentence
  if (sentences.length === 0 && normalized.length > 0) {
    sentences.push(normalized);
  }

  return sentences;
}

/**
 * Score a sentence based on action word matches
 */
function scoreSentence(sentence, actionWords) {
  const lower = sentence.toLowerCase();
  let score = 0;

  for (const word of actionWords) {
    // Match whole words only
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(lower)) {
      score += 1;
    }
  }

  return score;
}

/**
 * Extractive summarization using action words
 * Returns key sentences that describe what was done
 */
function extractiveSummarize(text, config) {
  const sentences = splitSentences(text);

  if (sentences.length === 0) {
    return text;
  }

  // If already short enough, return as-is
  if (sentences.length <= config.maxSummarySentences) {
    return sentences.join(' ');
  }

  const actionWords = config.actionWords || [];

  // Score each sentence (except first - we always keep it)
  const scored = sentences.slice(1).map((sentence, index) => ({
    sentence,
    originalIndex: index + 1,
    score: scoreSentence(sentence, actionWords)
  }));

  // Sort by score descending, then by original position
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  // Take top N-1 sentences (first sentence is always included)
  const topSentences = scored.slice(0, config.maxSummarySentences - 1);

  // Sort back to original order
  topSentences.sort((a, b) => a.originalIndex - b.originalIndex);

  // Combine first sentence with top scored sentences
  const result = [sentences[0], ...topSentences.map(s => s.sentence)];

  return result.join(' ');
}

function processStop(hookData) {
  const { transcript, cwd } = hookData;

  if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
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
    content: `Assistant: ${processed}`
  };

  appendFileSync(paths.log, JSON.stringify(entry) + '\n');
  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 5000);
