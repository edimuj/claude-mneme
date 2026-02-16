/**
 * CaptureService — Server-side response capture
 *
 * Receives stop-hook forwarded data, waits for transcript file stability,
 * extracts final assistant response, processes it, writes log entry + handoff.
 *
 * Eliminates the race condition where the hook reads stale transcript data
 * because the file hasn't been fully flushed by Claude Code yet.
 */

import { statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stripMarkdown, extractiveSummarize, loadConfig } from '../scripts/utils.mjs';

const STABILITY_POLL_MS = 200;
const STABILITY_TIMEOUT_MS = 8000;
const PREFIX_LENGTH = 100;

export class CaptureService {
  constructor(config, logger, getProjectDir, logService) {
    this.config = config;
    this.logger = logger;
    this.getProjectDir = getProjectDir;
    this.logService = logService;

    // In-flight tracking: one capture per project at a time
    this.processing = new Map();
    // Dedup: last captured prefix per project
    this.lastCapturedPrefix = new Map();

    this.stats = {
      capturesReceived: 0,
      processed: 0,
      deduped: 0,
      failed: 0,
      skipped: 0,
      handoffs: 0
    };
  }

  /**
   * Accept a capture request. Returns immediately, processes async.
   * @returns {{ ok: boolean, accepted: boolean }}
   */
  capture(project, hookData) {
    this.stats.capturesReceived++;

    // Reject if already processing this project
    if (this.processing.has(project)) {
      this.logger.debug('capture-already-processing', { project });
      this.stats.skipped++;
      return { ok: true, accepted: false, reason: 'already-processing' };
    }

    // Fire-and-forget processing
    const promise = this._processCapture(project, hookData)
      .catch(err => {
        this.stats.failed++;
        this.logger.error('capture-failed', {
          project,
          error: err.message,
          stack: err.stack
        });
      })
      .finally(() => {
        this.processing.delete(project);
      });

    this.processing.set(project, promise);
    return { ok: true, accepted: true };
  }

  /**
   * Background processing of a stop-capture event
   */
  async _processCapture(project, hookData) {
    const { transcript_path } = hookData;

    if (!transcript_path) {
      this.logger.warn('capture-no-transcript-path', { project });
      return;
    }

    // Wait for file to stabilize (Claude Code may still be flushing)
    const stable = await this._waitForStableFile(transcript_path);
    if (!stable) {
      this.logger.warn('capture-file-not-stable', { project, transcript_path });
      // Read anyway — graceful degradation
    }

    // Parse transcript
    const transcript = this._readTranscript(transcript_path);
    if (!transcript || transcript.length === 0) {
      this.logger.debug('capture-empty-transcript', { project, transcript_path });
      return;
    }

    // Extract last assistant text
    const textContent = this._extractLastAssistantText(transcript);
    if (!textContent) {
      this.logger.debug('capture-no-assistant-text', { project, entries: transcript.length });
      return;
    }

    // Skip /remember responses
    if (this._isRememberResponse(textContent)) {
      this.logger.debug('capture-skip-remember', { project });
      return;
    }

    // Process text: strip markdown, optional summarization, length cap
    const userConfig = loadConfig();
    const processed = this._processResponseText(textContent, userConfig);

    // Dedup check
    if (this._isDuplicate(project, processed)) {
      this.stats.deduped++;
      this.logger.debug('capture-duplicate', { project });
      return;
    }

    // Write log entry via LogService
    const entry = {
      ts: new Date().toISOString(),
      type: 'response',
      content: processed
    };
    this.logService.append(project, entry);
    this.stats.processed++;

    this.logger.info('capture-logged', {
      project,
      contentLength: processed.length
    });

    // Update dedup state
    this.lastCapturedPrefix.set(project, processed.substring(0, PREFIX_LENGTH).toLowerCase());

    // Build and write handoff
    try {
      const handoff = this._extractHandoff(transcript, processed);
      this._writeHandoff(project, handoff);
      this.stats.handoffs++;
    } catch (err) {
      this.logger.error('capture-handoff-failed', {
        project,
        error: err.message
      });
    }
  }

  // --- File stability ---

  /**
   * Poll file size until stable for STABILITY_POLL_MS.
   * Returns true if stabilized within timeout, false otherwise.
   */
  async _waitForStableFile(filePath) {
    const deadline = Date.now() + STABILITY_TIMEOUT_MS;
    let lastSize = -1;
    let stableSince = 0;

    while (Date.now() < deadline) {
      try {
        const size = statSync(filePath).size;
        if (size === lastSize) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= STABILITY_POLL_MS) {
            return true;
          }
        } else {
          lastSize = size;
          stableSince = 0;
        }
      } catch {
        // File doesn't exist yet — keep waiting
        lastSize = -1;
        stableSince = 0;
      }

      await new Promise(r => setTimeout(r, 50));
    }

    return false;
  }

  // --- Transcript parsing ---

  /**
   * Parse JSONL transcript file into [{role, content}]
   */
  _readTranscript(transcriptPath) {
    try {
      const content = readFileSync(transcriptPath, 'utf-8').trim();
      if (!content) return null;

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
   * Walk backward through transcript to find last assistant entry with text.
   * Skips tool-only entries (content arrays with no text blocks).
   */
  _extractLastAssistantText(transcript) {
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].role === 'assistant') {
        const text = this._extractTextContent(transcript[i].content);
        if (text && text.trim().length > 0) {
          return text;
        }
      }
    }
    return '';
  }

  /**
   * Extract text from content (string or content blocks array)
   */
  _extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
    }
    return '';
  }

  // --- Response processing ---

  /**
   * Strip markdown, optionally summarize, cap length
   */
  _processResponseText(text, config) {
    let processed = stripMarkdown(text);

    const mode = config.responseSummarization || 'none';
    if (mode === 'extractive') {
      processed = extractiveSummarize(processed, config);
    }

    if (processed.length > config.maxResponseLength) {
      processed = processed.substring(0, config.maxResponseLength) + '...';
    }

    return processed;
  }

  /**
   * In-memory prefix dedup — no file reads needed
   */
  _isDuplicate(project, text) {
    const prefix = text.substring(0, PREFIX_LENGTH).toLowerCase();
    const lastPrefix = this.lastCapturedPrefix.get(project);
    if (!lastPrefix) return false;
    return prefix === lastPrefix || prefix.startsWith(lastPrefix) || lastPrefix.startsWith(prefix);
  }

  /**
   * Detect /remember command responses (already persisted elsewhere)
   */
  _isRememberResponse(text) {
    return [
      /what would you like me to remember/i,
      /remembered\.json/,
      /this will persist across all future sessions/i,
    ].some(p => p.test(text));
  }

  // --- Handoff extraction ---

  /**
   * Build handoff data for next session pickup
   */
  _extractHandoff(transcript, responseSummary) {
    // Walk backward for last meaningful user prompt (skip confirmations)
    let workingOn = null;
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].role === 'user') {
        const text = this._extractTextContent(transcript[i].content);
        if (text && text.length >= 20 && !this._isConfirmation(text)) {
          workingOn = text.substring(0, 300);
          break;
        }
      }
    }

    // Get full last assistant text for insight/open-items extraction
    const lastAssistantText = this._extractLastAssistantText(transcript);

    return {
      ts: new Date().toISOString(),
      workingOn,
      lastDone: responseSummary || null,
      keyInsight: this._extractKeyInsight(lastAssistantText),
      openItems: this._extractOpenItems(lastAssistantText),
    };
  }

  _isConfirmation(text) {
    const PATTERN = /^(y(es)?|no?|ok(ay)?|sure|go ahead|continue|do it|sounds good|lgtm|looks good|please|yep|yup|nope|correct|right|exactly|agreed|confirmed?)\.?$/i;
    return text.trim().length < 20 || PATTERN.test(text.trim());
  }

  /**
   * Extract the single most important insight from assistant text.
   */
  _extractKeyInsight(text) {
    if (!text || text.length < 30) return null;

    const indicators = [
      /\b(?:root cause|the problem was|the issue was|the bug was)\b/i,
      /\b(?:turns out|it turns out|discovered that)\b/i,
      /\b(?:chose|decided|going with|switched to)\b.*\b(?:because|since|due to)\b/i,
      /\b(?:the fix was|fixed by|resolved by|the solution)\b/i,
      /\b(?:tried .+ (?:but|however|didn't work|failed))\b/i,
      /\b(?:because|the reason)\b/i,
    ];

    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.length >= 20);

    for (const pattern of indicators) {
      const match = sentences.find(s => pattern.test(s));
      if (match) {
        return match.length > 200 ? match.slice(0, 200) + '...' : match;
      }
    }

    return null;
  }

  /**
   * Extract open items / next steps from assistant text
   */
  _extractOpenItems(text) {
    if (!text) return [];
    const items = [];
    const patterns = [
      /(?:next steps?|todo|remaining|still need to|should|need to|plan to)[:\s]+(.+)/gi,
      /(?:^|\n)\s*[-*]\s*\[[ ]\]\s*(.+)/gm,
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
   * Write handoff.json to project directory
   */
  _writeHandoff(project, handoff) {
    const projectDir = this.getProjectDir(project);
    const handoffPath = join(projectDir, 'handoff.json');
    writeFileSync(handoffPath, JSON.stringify(handoff, null, 2) + '\n');
  }

  // --- Lifecycle ---

  getStats() {
    return { ...this.stats, inflight: this.processing.size };
  }

  async shutdown() {
    if (this.processing.size === 0) return;

    this.logger.info('capture-shutdown', { inflight: this.processing.size });

    // Wait for in-flight captures with a 5s timeout
    const timeout = new Promise(r => setTimeout(r, 5000));
    const all = Promise.all([...this.processing.values()]);
    await Promise.race([all, timeout]);
  }
}
