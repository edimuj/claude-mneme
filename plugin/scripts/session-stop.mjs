#!/usr/bin/env node
/**
 * Session Stop Hook
 * Triggers project-specific summarization if log has grown beyond threshold
 * Uses Claude Agent SDK to run Haiku for compression
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { ensureMemoryDirs, loadConfig, getProjectName, CONFIG_FILE } from './utils.mjs';

const cwd = process.cwd();
const paths = ensureMemoryDirs(cwd);
const config = loadConfig();
const projectName = getProjectName(cwd);

// Write default config if it doesn't exist
if (!existsSync(CONFIG_FILE)) {
  writeFileSync(CONFIG_FILE, JSON.stringify({
    maxLogEntriesBeforeSummarize: 50,
    keepRecentEntries: 10,
    model: 'claude-haiku-4-20250514',
    claudePath: '/Users/admin/.local/bin/claude'
  }, null, 2));
}

// Check if log exists and has entries
if (!existsSync(paths.log)) {
  process.exit(0);
}

const logContent = readFileSync(paths.log, 'utf-8').trim();
if (!logContent) {
  process.exit(0);
}

const lines = logContent.split('\n').filter(l => l);
const entryCount = lines.length;

// Check if we need to summarize
if (entryCount < config.maxLogEntriesBeforeSummarize) {
  process.exit(0);
}

console.error(`[claude-mneme] Summarizing ${entryCount} entries for project "${projectName}"...`);

// Calculate entries to summarize vs keep
const summarizeCount = entryCount - config.keepRecentEntries;
if (summarizeCount <= 0) {
  process.exit(0);
}

const entriesToSummarize = lines.slice(0, summarizeCount);
const entriesToKeep = lines.slice(summarizeCount);

// Read existing summary
let existingSummary = '';
if (existsSync(paths.summary)) {
  existingSummary = readFileSync(paths.summary, 'utf-8').trim();
}

// Format entries for the prompt
const entriesText = entriesToSummarize.map(line => {
  try {
    const entry = JSON.parse(line);
    return `[${entry.ts}] (${entry.type}) ${entry.content}`;
  } catch {
    return line;
  }
}).join('\n');

// Build summarization prompt
const prompt = `You are updating a memory summary for a Claude Code assistant working on the project "${projectName}".

Here is the existing summary:
<existing_summary>
${existingSummary || '(No existing summary)'}
</existing_summary>

Here are new memory entries to incorporate:
<new_entries>
${entriesText}
</new_entries>

Update the summary to incorporate the new information. Keep it concise and organized into these sections:
- Project Context (what this project is about)
- Key Decisions (important choices made)
- Current State (where things stand)

Remove outdated information. Keep the total summary under 500 words. Output only the updated markdown summary, starting with '# Claude Memory Summary'.`;

// Run summarization using Agent SDK
try {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  async function* messageGenerator() {
    yield {
      type: 'user',
      message: { role: 'user', content: prompt },
      session_id: `memory-summarize-${Date.now()}`,
      parent_tool_use_id: null,
      isSynthetic: true
    };
  }

  const queryResult = query({
    prompt: messageGenerator(),
    options: {
      model: config.model,
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'],
      pathToClaudeCodeExecutable: config.claudePath
    }
  });

  let newSummary = '';

  try {
    for await (const message of queryResult) {
      if (message.type === 'assistant') {
        const content = message.message.content;
        const textContent = Array.isArray(content)
          ? content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : typeof content === 'string' ? content : '';
        newSummary = textContent;
      }
    }
  } catch (iterError) {
    // Agent SDK may throw on process exit even after getting response
    // If we already captured a summary, we can still use it
    if (!newSummary && iterError.message?.includes('process exited')) {
      console.error(`[claude-mneme] Agent SDK process exit (may still have response)`);
    } else if (!newSummary) {
      throw iterError;
    }
  }

  if (newSummary && newSummary.includes('# Claude Memory Summary')) {
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0] + ' UTC';
    const finalSummary = newSummary.replace(
      /\*Last updated:.*\*/,
      `*Last updated: ${timestamp}*`
    );

    writeFileSync(paths.summary, finalSummary);
    writeFileSync(paths.log, entriesToKeep.join('\n') + (entriesToKeep.length ? '\n' : ''));

    console.error(`[claude-mneme] Summary updated for "${projectName}". Kept ${entriesToKeep.length} recent entries.`);
  } else if (newSummary) {
    // Got a response but it didn't match expected format - save it anyway
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0] + ' UTC';
    const finalSummary = `# Claude Memory Summary\n\n*Last updated: ${timestamp}*\n\n${newSummary}`;

    writeFileSync(paths.summary, finalSummary);
    writeFileSync(paths.log, entriesToKeep.join('\n') + (entriesToKeep.length ? '\n' : ''));

    console.error(`[claude-mneme] Summary updated for "${projectName}" (reformatted). Kept ${entriesToKeep.length} recent entries.`);
  } else {
    console.error('[claude-mneme] Summarization returned no result, keeping log intact');
  }

} catch (error) {
  console.error(`[claude-mneme] Summarization error: ${error.message}`);
}

process.exit(0);
