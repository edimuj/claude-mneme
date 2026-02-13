#!/usr/bin/env node
/**
 * PreCompact Hook - Context Preservation
 *
 * Fires before Claude Code compacts the conversation. This is an opportunity to:
 * 1. Flush pending log entries
 * 2. Extract important context from the transcript before it's compressed
 * 3. Force immediate summarization
 * 4. Optionally save a transcript snapshot
 *
 * All behavior is configurable via ~/.claude-mneme/config.json under "preCompact"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { ensureDeps, ensureMemoryDirs, loadConfig, getProjectName, flushPendingLog, appendLogEntry, withoutNestedSessionGuard, logError } from './utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  try {
    const hookData = JSON.parse(input);
    await processPreCompact(hookData);
  } catch (e) {
    console.error(`[claude-mneme] PreCompact error: ${e.message}`);
    process.exit(0);
  }
});

/**
 * Read and parse transcript from file path
 */
function readTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return [];
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return [];

    const lines = content.split('\n').filter(l => l.trim());
    const transcript = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        transcript.push(entry);
      } catch {
        // Skip malformed lines
      }
    }

    return transcript;
  } catch {
    return [];
  }
}

/**
 * Extract text content from a message
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

/**
 * Extract decisions/choices from transcript
 */
function extractDecisions(transcript, maxItems) {
  const decisions = [];
  const decisionPatterns = [
    /(?:decided|choosing|going with|selected|picked|using|will use|opted for)\s+(.{10,100})/gi,
    /(?:the approach|the solution|the plan) (?:is|will be)\s+(.{10,100})/gi,
    /(?:let's|we'll|I'll)\s+(?:go with|use|implement)\s+(.{10,100})/gi,
  ];

  for (const entry of transcript) {
    if (entry.type !== 'assistant') continue;
    const text = extractText(entry.message?.content);
    if (!text) continue;

    for (const pattern of decisionPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null && decisions.length < maxItems) {
        const decision = match[1].trim().replace(/[.,:;]$/, '');
        if (decision.length > 10 && !decisions.includes(decision)) {
          decisions.push(decision);
        }
      }
    }
  }

  return decisions.slice(0, maxItems);
}

/**
 * Extract file paths mentioned in transcript
 */
function extractFiles(transcript, maxItems) {
  const files = new Set();
  const filePatterns = [
    /(?:^|[\s"'`])([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,10})(?:[\s"'`:]|$)/g,
    /(?:file|path|in|from|to|edit|read|write|create)\s+[`"']?([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,10})[`"']?/gi,
  ];

  const skipExtensions = ['com', 'org', 'net', 'io', 'dev', 'app'];

  for (const entry of transcript) {
    const text = extractText(entry.message?.content || entry.content);
    if (!text) continue;

    for (const pattern of filePatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const file = match[1];
        const ext = file.split('.').pop()?.toLowerCase();
        if (ext && !skipExtensions.includes(ext) && file.length < 100) {
          files.add(file);
        }
      }
    }

    if (files.size >= maxItems * 2) break;
  }

  return Array.from(files).slice(0, maxItems);
}

/**
 * Extract errors encountered in transcript
 */
function extractErrors(transcript, maxItems) {
  const errors = [];
  const errorPatterns = [
    /(?:error|exception|failed|failure):\s*(.{10,150})/gi,
    /(?:cannot|can't|couldn't|unable to)\s+(.{10,100})/gi,
    /(?:TypeError|ReferenceError|SyntaxError|Error):\s*(.{10,150})/gi,
  ];

  for (const entry of transcript) {
    const text = extractText(entry.message?.content || entry.content);
    if (!text) continue;

    for (const pattern of errorPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null && errors.length < maxItems) {
        const error = match[1].trim().replace(/[.,:;]$/, '');
        if (error.length > 10 && !errors.some(e => e.includes(error) || error.includes(e))) {
          errors.push(error);
        }
      }
    }
  }

  return errors.slice(0, maxItems);
}

/**
 * Extract TODOs and action items
 */
function extractTodos(transcript, maxItems) {
  const todos = [];
  const todoPatterns = [
    /(?:TODO|FIXME|HACK|XXX):\s*(.{10,100})/gi,
    /(?:we |you |I )?(?:need to|should|must|have to)\s+((?:add|fix|update|create|remove|implement|refactor|change|move|rename|delete|migrate|test|check|verify|ensure|resolve|handle|configure|set up|clean up)\b.{5,100})/gi,
    /(?:next step|action item|follow.?up):\s*(.{10,100})/gi,
  ];

  for (const entry of transcript) {
    if (entry.type !== 'assistant') continue;
    const text = extractText(entry.message?.content);
    if (!text) continue;

    for (const pattern of todoPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null && todos.length < maxItems) {
        const todo = match[1].trim().replace(/[.,:;]$/, '');
        if (todo.length > 10 && !todos.includes(todo)) {
          todos.push(todo);
        }
      }
    }
  }

  return todos.slice(0, maxItems);
}

/**
 * Extract key discussion points using AI
 */
async function extractKeyPoints(transcript, config, maxItems) {
  // Get the last N messages for context
  const recentMessages = transcript.slice(-20);
  const conversationText = recentMessages
    .filter(e => e.type === 'user' || e.type === 'assistant')
    .map(e => {
      const role = e.type === 'user' ? 'User' : 'Assistant';
      const text = extractText(e.message?.content || e.content);
      return `${role}: ${text.substring(0, 500)}`;
    })
    .join('\n\n');

  if (!conversationText || conversationText.length < 100) {
    return [];
  }

  const prompt = `Extract the ${maxItems} most important key points from this conversation that should be remembered. Focus on:
- Decisions made
- Problems solved
- Important discoveries
- User preferences expressed

<conversation>
${conversationText.substring(0, 4000)}
</conversation>

Output ONLY a JSON array of strings, each being a concise key point (max 100 chars each).
Example: ["Decided to use TypeScript for type safety", "Fixed auth bug by adding token refresh"]`;

  try {
    ensureDeps();
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    async function* messageGenerator() {
      yield {
        type: 'user',
        message: { role: 'user', content: prompt },
        session_id: `pre-compact-${Date.now()}`,
        parent_tool_use_id: null,
        isSynthetic: true
      };
    }

    const response = await withoutNestedSessionGuard(async () => {
      let stderrOutput = '';
      const queryResult = query({
        prompt: messageGenerator(),
        options: {
          model: config.model,
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'],
          pathToClaudeCodeExecutable: config.claudePath,
          stderr: (data) => { stderrOutput += data; }
        }
      });

      let result = '';
      try {
        for await (const message of queryResult) {
          if (message.type === 'assistant') {
            const content = message.message.content;
            result = Array.isArray(content)
              ? content.filter(c => c.type === 'text').map(c => c.text).join('\n')
              : typeof content === 'string' ? content : '';
          }
        }
      } catch (iterError) {
        if (!result) {
          iterError.message += stderrOutput ? ` | stderr: ${stderrOutput.slice(0, 500)}` : ' | no stderr';
          throw iterError;
        }
      }
      return result;
    });

    if (response) {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const points = JSON.parse(jsonMatch[0]);
        return points.slice(0, maxItems);
      }
    }
  } catch (error) {
    console.error(`[claude-mneme] Key points extraction error: ${error.message}`);
  }

  return [];
}

/**
 * Save transcript snapshot, rotating old snapshots to keep at most maxCount.
 */
function saveSnapshot(transcript, paths, trigger, maxCount = 10) {
  const snapshotDir = join(paths.project, 'snapshots');
  if (!existsSync(snapshotDir)) {
    mkdirSync(snapshotDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = join(snapshotDir, `pre-compact-${trigger}-${timestamp}.jsonl`);

  const content = transcript.map(e => JSON.stringify(e)).join('\n');
  writeFileSync(snapshotPath, content + '\n');

  // Rotate: keep only the most recent maxCount snapshots
  try {
    const files = readdirSync(snapshotDir)
      .filter(f => f.startsWith('pre-compact-') && f.endsWith('.jsonl'))
      .sort(); // Lexicographic sort works because timestamps are ISO-formatted
    if (files.length > maxCount) {
      for (const old of files.slice(0, files.length - maxCount)) {
        unlinkSync(join(snapshotDir, old));
      }
    }
  } catch (e) {
    logError(e, 'pre-compact:snapshotRotation');
  }

  console.error(`[claude-mneme] Saved transcript snapshot: ${snapshotPath}`);
  return snapshotPath;
}

/**
 * Force run summarization script
 */
function forceSummarize(cwd) {
  const summarizeScript = join(__dirname, 'summarize.mjs');

  return new Promise((resolve) => {
    const child = spawn('node', [summarizeScript, cwd], {
      stdio: 'inherit',
      cwd
    });

    child.on('close', () => resolve());
    child.on('error', () => resolve());

    // Timeout after 60 seconds
    setTimeout(() => {
      try { child.kill(); } catch {}
      resolve();
    }, 60000);
  });
}

/**
 * Main processing function
 */
async function processPreCompact(hookData) {
  const { trigger, transcript_path, cwd, custom_instructions } = hookData;
  const workingDir = cwd || process.cwd();
  const config = loadConfig();
  const pcConfig = config.preCompact || {};

  // Check if hook is enabled
  if (pcConfig.enabled === false) {
    process.exit(0);
    return;
  }

  // Check if we should respond to this trigger
  const triggers = pcConfig.triggers || ['auto', 'manual'];
  if (!triggers.includes(trigger)) {
    process.exit(0);
    return;
  }

  const paths = ensureMemoryDirs(workingDir);
  const projectName = getProjectName(workingDir);

  console.error(`[claude-mneme] PreCompact triggered (${trigger}) for "${projectName}"`);

  // 1. Flush pending log entries
  if (pcConfig.flushPending !== false) {
    flushPendingLog(workingDir, 0);
  }

  // 2. Read transcript
  const transcript = readTranscript(transcript_path);

  // 3. Save snapshot if enabled
  if (pcConfig.saveSnapshot && transcript.length > 0) {
    saveSnapshot(transcript, paths, trigger);
  }

  // 4. Extract context if enabled
  if (pcConfig.extractContext !== false && transcript.length > 0) {
    const extraction = pcConfig.extraction || {};
    const categories = extraction.categories || {};
    const maxItems = extraction.maxItems || 10;

    const extracted = {
      ts: new Date().toISOString(),
      trigger,
      customInstructions: custom_instructions || null
    };

    let hasContent = false;

    if (categories.decisions !== false) {
      const decisions = extractDecisions(transcript, maxItems);
      if (decisions.length > 0) {
        extracted.decisions = decisions;
        hasContent = true;
      }
    }

    if (categories.files !== false) {
      const files = extractFiles(transcript, maxItems);
      if (files.length > 0) {
        extracted.files = files;
        hasContent = true;
      }
    }

    if (categories.errors !== false) {
      const errors = extractErrors(transcript, maxItems);
      if (errors.length > 0) {
        extracted.errors = errors;
        hasContent = true;
      }
    }

    if (categories.todos !== false) {
      const todos = extractTodos(transcript, maxItems);
      if (todos.length > 0) {
        extracted.todos = todos;
        hasContent = true;
      }
    }

    if (categories.keyPoints !== false) {
      const keyPoints = await extractKeyPoints(transcript, config, maxItems);
      if (keyPoints.length > 0) {
        extracted.keyPoints = keyPoints;
        hasContent = true;
      }
    }

    // Save extracted context
    if (hasContent) {
      const extractedPath = join(paths.project, 'extracted-context.json');

      // Append to existing extractions (keep last 5)
      let extractions = [];
      if (existsSync(extractedPath)) {
        try {
          extractions = JSON.parse(readFileSync(extractedPath, 'utf-8'));
        } catch (e) {
          logError(e, 'pre-compact:extracted-context.json');
        }
      }

      extractions.push(extracted);
      if (extractions.length > 5) {
        extractions = extractions.slice(-5);
      }

      writeFileSync(extractedPath, JSON.stringify(extractions, null, 2) + '\n');
      console.error(`[claude-mneme] Extracted context saved (${Object.keys(extracted).length - 3} categories)`);

      // Log a summary entry
      const summaryParts = [];
      if (extracted.decisions?.length) summaryParts.push(`${extracted.decisions.length} decisions`);
      if (extracted.files?.length) summaryParts.push(`${extracted.files.length} files`);
      if (extracted.errors?.length) summaryParts.push(`${extracted.errors.length} errors`);
      if (extracted.keyPoints?.length) summaryParts.push(`${extracted.keyPoints.length} key points`);

      if (summaryParts.length > 0) {
        await appendLogEntry({
          ts: new Date().toISOString(),
          type: 'compact',
          trigger,
          content: `Pre-compact extraction: ${summaryParts.join(', ')}`
        }, workingDir);
      }
    }
  }

  // 5. Force summarization if enabled
  if (pcConfig.forceSummarize !== false) {
    console.error(`[claude-mneme] Forcing summarization before compact...`);
    await forceSummarize(workingDir);
  }

  console.error(`[claude-mneme] PreCompact processing complete`);
  process.exit(0);
}

// Timeout fallback
setTimeout(() => process.exit(0), 120000);
