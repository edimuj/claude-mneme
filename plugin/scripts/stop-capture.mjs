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
import { ensureMemoryDirs, loadConfig, maybeSummarize } from './utils.mjs';

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

/**
 * Split text into logical units (sentences, paragraphs, bullet items)
 * Handles markdown formatting, bullet lists, and paragraph breaks
 */
function splitSentences(text) {
  const units = [];

  // Step 1: Split on paragraph breaks first (preserves structure)
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());

  for (const para of paragraphs) {
    // Step 2: Check if this paragraph is a bullet list
    const lines = para.split('\n').map(l => l.trim()).filter(l => l);
    const isBulletList = lines.every(l => /^[-*•]\s/.test(l) || l === '');

    if (isBulletList) {
      // Each bullet item becomes a unit
      for (const line of lines) {
        const content = line.replace(/^[-*•]\s+/, '').trim();
        if (content) {
          units.push(content);
        }
      }
    } else {
      // Step 3: Split paragraph into sentences
      // Normalize internal whitespace but preserve the paragraph as a unit first
      const normalized = para.replace(/\s+/g, ' ').trim();

      // Split on sentence boundaries (period/!/? followed by space and capital)
      const sentences = normalized.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(s => s.trim());

      if (sentences.length > 0) {
        units.push(...sentences);
      } else if (normalized) {
        units.push(normalized);
      }
    }
  }

  // Fallback: if nothing was extracted, return original text normalized
  if (units.length === 0 && text.trim()) {
    units.push(text.replace(/\s+/g, ' ').trim());
  }

  return units;
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

  // Check if summarization is needed
  maybeSummarize(cwd || process.cwd());

  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 5000);
