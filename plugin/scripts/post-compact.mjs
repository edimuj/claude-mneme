#!/usr/bin/env node
/**
 * Post-Compact Hook (via SessionStart with "compact" matcher)
 *
 * Fires after Claude Code compacts the conversation.
 * Injects extracted context back into the conversation to restore important information.
 *
 * Configurable via ~/.claude-mneme/config.json under "postCompact"
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ensureMemoryDirs, loadConfig, getProjectName, escapeAttr } from './utils.mjs';

const cwd = process.cwd();
const paths = ensureMemoryDirs(cwd);
const config = loadConfig();
const projectName = getProjectName(cwd);
const pcConfig = config.postCompact || {};

// Check if hook is enabled
if (pcConfig.enabled === false) {
  process.exit(0);
}

// Read extracted context from PreCompact
const extractedPath = join(paths.project, 'extracted-context.json');
let extractions = [];

if (existsSync(extractedPath)) {
  try {
    extractions = JSON.parse(readFileSync(extractedPath, 'utf-8'));
  } catch {
    extractions = [];
  }
}

// Get the most recent extraction
const latest = extractions[extractions.length - 1];

if (!latest) {
  // No extracted context to inject
  process.exit(0);
}

// Check how recent the extraction is (within last 5 minutes)
const extractionAge = Date.now() - new Date(latest.ts).getTime();
const maxAge = (pcConfig.maxAgeMinutes || 5) * 60 * 1000;

if (extractionAge > maxAge) {
  // Extraction is too old, skip injection
  process.exit(0);
}

// Build injection output
const sections = [];

sections.push(`<claude-mneme-restored project="${escapeAttr(projectName)}">`);
sections.push('## Context Restored After Compaction\n');
sections.push('The following context was extracted before compaction and may be relevant:\n');

// Inject based on configuration
const categories = pcConfig.categories || {
  keyPoints: true,
  decisions: true,
  files: true,
  errors: true,
  todos: true
};

if (categories.keyPoints !== false && latest.keyPoints?.length > 0) {
  sections.push('### Key Points');
  for (const point of latest.keyPoints) {
    sections.push(`- ${point}`);
  }
  sections.push('');
}

if (categories.decisions !== false && latest.decisions?.length > 0) {
  sections.push('### Decisions Made');
  for (const decision of latest.decisions) {
    sections.push(`- ${decision}`);
  }
  sections.push('');
}

if (categories.files !== false && latest.files?.length > 0) {
  const maxFiles = pcConfig.maxFiles || 10;
  const files = latest.files.slice(0, maxFiles);
  sections.push('### Files Referenced');
  sections.push(`\`${files.join('`, `')}\``);
  sections.push('');
}

if (categories.errors !== false && latest.errors?.length > 0) {
  sections.push('### Errors Encountered');
  for (const error of latest.errors) {
    sections.push(`- ${error}`);
  }
  sections.push('');
}

if (categories.todos !== false && latest.todos?.length > 0) {
  sections.push('### Pending Items');
  for (const todo of latest.todos) {
    sections.push(`- ${todo}`);
  }
  sections.push('');
}

// Add custom instructions if any were provided during compact
if (latest.customInstructions) {
  sections.push('### User Instructions for Compaction');
  sections.push(latest.customInstructions);
  sections.push('');
}

sections.push('</claude-mneme-restored>');

// Only output if we have meaningful content
const hasContent = latest.keyPoints?.length > 0 ||
                   latest.decisions?.length > 0 ||
                   latest.files?.length > 0 ||
                   latest.errors?.length > 0 ||
                   latest.todos?.length > 0 ||
                   latest.customInstructions;

if (hasContent) {
  console.log(sections.join('\n'));
}

process.exit(0);
