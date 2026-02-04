#!/usr/bin/env node
/**
 * Remove entries from the project's persistent remembered.json
 *
 * Usage:
 *   node mem-forget.mjs --list                    List all entries with indices
 *   node mem-forget.mjs --remove 0,2,3            Remove entries at indices
 *   node mem-forget.mjs --match "description"     AI-assisted matching
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { ensureMemoryDirs, loadConfig, getProjectName } from './utils.mjs';

const cwd = process.cwd();
const paths = ensureMemoryDirs(cwd);
const projectName = getProjectName(cwd);
const config = loadConfig();

// Parse arguments
const args = process.argv.slice(2);
const mode = args[0];

// Read existing entries
function readEntries() {
  if (!existsSync(paths.remembered)) {
    return [];
  }
  try {
    return JSON.parse(readFileSync(paths.remembered, 'utf-8'));
  } catch {
    return [];
  }
}

// Write entries back
function writeEntries(entries) {
  writeFileSync(paths.remembered, JSON.stringify(entries, null, 2) + '\n');
}

// Format entry for display
function formatEntry(entry, index) {
  const date = new Date(entry.ts).toLocaleDateString();
  return `[${index}] (${entry.type}) ${entry.content} — ${date}`;
}

// List mode
if (mode === '--list') {
  const entries = readEntries();
  if (entries.length === 0) {
    console.log('No remembered items for this project.');
    process.exit(0);
  }

  // Output as JSON for easy parsing by Claude
  const output = entries.map((entry, index) => ({
    index,
    type: entry.type,
    content: entry.content,
    date: new Date(entry.ts).toLocaleDateString()
  }));
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

// Remove mode
if (mode === '--remove') {
  const indicesArg = args[1];
  if (!indicesArg) {
    console.error('Usage: node mem-forget.mjs --remove 0,2,3');
    process.exit(1);
  }

  const indices = indicesArg.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  if (indices.length === 0) {
    console.error('No valid indices provided.');
    process.exit(1);
  }

  const entries = readEntries();
  if (entries.length === 0) {
    console.log('No remembered items to remove.');
    process.exit(0);
  }

  // Validate indices
  const invalid = indices.filter(i => i < 0 || i >= entries.length);
  if (invalid.length > 0) {
    console.error(`Invalid indices: ${invalid.join(', ')}. Valid range: 0-${entries.length - 1}`);
    process.exit(1);
  }

  // Remove entries (work backwards to preserve indices)
  const removed = [];
  const sortedIndices = [...indices].sort((a, b) => b - a);
  for (const idx of sortedIndices) {
    removed.unshift(entries[idx]);
    entries.splice(idx, 1);
  }

  writeEntries(entries);

  console.log(`Removed ${removed.length} item(s) from "${projectName}":`);
  for (const entry of removed) {
    console.log(`  - [${entry.type}] ${entry.content}`);
  }
  process.exit(0);
}

// Match mode (AI-assisted)
if (mode === '--match') {
  const query = args.slice(1).join(' ');
  if (!query) {
    console.error('Usage: node mem-forget.mjs --match "description of what to forget"');
    process.exit(1);
  }

  const entries = readEntries();
  if (entries.length === 0) {
    console.log(JSON.stringify({ matches: [], message: 'No remembered items to search.' }));
    process.exit(0);
  }

  // Format entries for the AI prompt
  const entriesText = entries.map((entry, index) =>
    `[${index}] (${entry.type}) ${entry.content}`
  ).join('\n');

  const prompt = `You are helping identify which remembered items match a user's forget request.

Here are all the remembered items:
${entriesText}

The user wants to forget: "${query}"

Your task: Return ONLY a JSON object with the indices of items that match what the user wants to forget.
Format: {"indices": [0, 2], "reason": "brief explanation"}

If no items match, return: {"indices": [], "reason": "No matching items found"}

Be conservative - only match items that clearly relate to what the user described.
Return ONLY the JSON object, no other text.`;

  try {
    const { query: agentQuery } = await import('@anthropic-ai/claude-agent-sdk');

    async function* messageGenerator() {
      yield {
        type: 'user',
        message: { role: 'user', content: prompt },
        session_id: `memory-forget-${Date.now()}`,
        parent_tool_use_id: null,
        isSynthetic: true
      };
    }

    const queryResult = agentQuery({
      prompt: messageGenerator(),
      options: {
        model: config.model,
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'],
        pathToClaudeCodeExecutable: config.claudePath
      }
    });

    let response = '';

    try {
      for await (const message of queryResult) {
        if (message.type === 'assistant') {
          const content = message.message.content;
          response = Array.isArray(content)
            ? content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            : typeof content === 'string' ? content : '';
        }
      }
    } catch (iterError) {
      // Agent SDK may throw on process exit even after getting response
      if (!response && iterError.message?.includes('process exited')) {
        console.error('[claude-mneme] Agent SDK process exit');
      } else if (!response) {
        throw iterError;
      }
    }

    // Parse AI response
    if (response) {
      // Extract JSON from response (in case there's extra text)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const result = JSON.parse(jsonMatch[0]);
          // Enrich with entry details
          if (result.indices && result.indices.length > 0) {
            result.matches = result.indices.map(idx => ({
              index: idx,
              type: entries[idx]?.type,
              content: entries[idx]?.content
            })).filter(m => m.content); // Filter out invalid indices
            result.indices = result.matches.map(m => m.index);
          } else {
            result.matches = [];
          }
          console.log(JSON.stringify(result, null, 2));
          process.exit(0);
        } catch {
          // JSON parse failed
        }
      }
    }

    // Fallback if AI response wasn't parseable
    console.log(JSON.stringify({
      indices: [],
      matches: [],
      reason: 'Could not determine matching items. Please use --list and specify indices manually.'
    }));

  } catch (error) {
    console.error(`[claude-mneme] AI matching error: ${error.message}`);
    console.log(JSON.stringify({
      indices: [],
      matches: [],
      reason: `AI matching failed: ${error.message}. Use --list and specify indices manually.`
    }));
    process.exit(1);
  }

  process.exit(0);
}

// No valid mode specified
console.error(`Usage:
  node mem-forget.mjs --list                    List all entries with indices
  node mem-forget.mjs --remove 0,2,3            Remove entries at indices
  node mem-forget.mjs --match "description"     AI-assisted matching`);
process.exit(1);
