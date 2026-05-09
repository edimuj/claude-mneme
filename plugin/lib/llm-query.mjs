/**
 * Shared LLM query helper with retry logic.
 * Used by both summarize.mjs (server-triggered) and mem-summarize.mjs (manual).
 */

import { ensureDeps, loadConfig, resetConfigCache, withoutNestedSessionGuard } from '../scripts/utils.mjs';
import { logError } from './error-log.mjs';

const RETRYABLE_PATTERNS = [
  'native binary not found',
  'executable not found',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'socket hang up',
];

function isRetryableError(err) {
  const msg = (err.message || '') + (err.code || '');
  return RETRYABLE_PATTERNS.some(p => msg.includes(p));
}

/**
 * Query the LLM via claude-agent-sdk with one retry on transient failures.
 * On retry, resets the config cache so claudePath gets re-resolved.
 *
 * @param {string} prompt - The prompt text
 * @param {string} sessionPrefix - Session ID prefix for the SDK call
 * @param {object} [configOverride] - Optional config (defaults to loadConfig())
 * @returns {Promise<string>} The assistant's text response
 */
export async function queryWithRetry(prompt, sessionPrefix, configOverride) {
  let lastError;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      resetConfigCache();
      await new Promise(r => setTimeout(r, 1000));
    }

    try {
      const config = configOverride || loadConfig();
      ensureDeps();
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      async function* messageGenerator() {
        yield {
          type: 'user',
          message: { role: 'user', content: prompt },
          session_id: `${sessionPrefix}-${Date.now()}`,
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

      if (!response) {
        throw new Error('No response from summarization model');
      }

      return response;
    } catch (err) {
      lastError = err;

      if (attempt === 0 && isRetryableError(err)) {
        logError(err, `${sessionPrefix}:retry`);
        console.error(`[claude-mneme] Retrying after transient error: ${err.message}`);
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

/**
 * Query LLM and parse a JSON object from the response.
 * Retries once on transient SDK errors AND on JSON parse failures.
 *
 * @param {string} prompt - The prompt text
 * @param {string} sessionPrefix - Session ID prefix
 * @param {object} [configOverride] - Optional config
 * @returns {Promise<object>} Parsed JSON object from the response
 */
export async function queryJsonWithRetry(prompt, sessionPrefix, configOverride) {
  let lastError;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await queryWithRetry(prompt, sessionPrefix, configOverride);

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        const parseErr = new Error(`Could not parse JSON from response: ${response.substring(0, 500)}`);
        if (attempt === 0) {
          logError(parseErr, `${sessionPrefix}:json-retry`);
          console.error(`[claude-mneme] Retrying after JSON parse failure`);
          continue;
        }
        throw parseErr;
      }

      return JSON.parse(jsonMatch[0]);
    } catch (err) {
      lastError = err;
      if (attempt === 0 && (err.message || '').includes('Could not parse JSON')) {
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}
