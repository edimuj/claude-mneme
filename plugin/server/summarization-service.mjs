/**
 * SummarizationService
 *
 * Manages memory summarization with:
 * - Throttling (max 1 concurrent, 30s cooldown per project)
 * - Summary caching (5 min TTL)
 * - Entry count threshold check
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SUMMARIZE_SCRIPT = join(__dirname, '..', 'scripts', 'summarize.mjs');
import { Throttler, ThrottleError } from './throttler.mjs';
import { MemoryCache } from './memory-cache.mjs';

export class SummarizationService {
  constructor(config, logger, getProjectDir) {
    this.config = config;
    this.logger = logger;
    this.getProjectDir = getProjectDir; // Function to get project memory dir
    this.throttler = new Throttler({
      maxConcurrent: config.throttling?.summarize?.maxConcurrent || 1,
      cooldownMs: config.throttling?.summarize?.cooldownMs || 30000
    });
    this.cache = new MemoryCache({
      maxSize: config.cache?.maxSize || 100,
      ttlMs: config.cache?.ttlMs || 5 * 60 * 1000
    });
    this.running = new Map(); // project -> Promise
    this.stats = {
      summarizationsStarted: 0,
      summarizationsCompleted: 0,
      summarizationsFailed: 0,
      throttled: 0
    };

    // Periodic cache cleanup
    this.cleanupInterval = setInterval(() => {
      this.cache.cleanup();
    }, 60000);
  }

  /**
   * Trigger summarization (queued, throttled)
   */
  async trigger(project, force = false) {
    // Already running for this project?
    if (this.running.has(project)) {
      return {
        ok: true,
        queued: false,
        running: true,
        reason: 'already-running'
      };
    }

    // Check if needed (unless forced)
    if (!force && !this.isNeeded(project)) {
      return {
        ok: true,
        queued: false,
        running: false,
        reason: 'not-needed'
      };
    }

    // Try to execute (may throw ThrottleError)
    try {
      const promise = this.throttler.execute(project, () =>
        this.runSummarization(project)
      );

      this.running.set(project, promise);
      promise.finally(() => this.running.delete(project));

      this.stats.summarizationsStarted++;

      return {
        ok: true,
        queued: true,
        running: false
      };
    } catch (err) {
      if (err instanceof ThrottleError) {
        this.stats.throttled++;
        return {
          ok: true,
          queued: false,
          running: false,
          reason: err.reason,
          retryAfterMs: err.retryAfterMs
        };
      }
      throw err;
    }
  }

  /**
   * Check if summarization is needed
   */
  isNeeded(project) {
    const projectDir = this.getProjectDir(project);
    const logFile = join(projectDir, 'log.jsonl');
    const summaryFile = join(projectDir, 'summary.json');

    // No log file = nothing to summarize
    if (!existsSync(logFile)) {
      return false;
    }

    // Count log entries
    const logContent = readFileSync(logFile, 'utf-8');
    const entries = logContent.trim().split('\n').filter(Boolean);

    // Get last summarized entry count
    let lastSummarizedCount = 0;
    if (existsSync(summaryFile)) {
      try {
        const summary = JSON.parse(readFileSync(summaryFile, 'utf-8'));
        lastSummarizedCount = summary.lastEntryIndex || 0;
      } catch {
        // Invalid summary file, treat as 0
      }
    }

    const newEntries = entries.length - lastSummarizedCount;
    const threshold = this.config.summarization?.entryThreshold || 50;

    return newEntries >= threshold;
  }

  /**
   * Run summarization (spawns summarize.mjs script)
   */
  async runSummarization(project) {
    const projectDir = this.getProjectDir(project);

    this.logger.info('summarization-started', { project });

    return new Promise((resolve, reject) => {
      const child = spawn('node', [
        SUMMARIZE_SCRIPT,
        projectDir
      ], {
        stdio: 'inherit'
      });

      child.on('exit', (code) => {
        if (code === 0) {
          this.stats.summarizationsCompleted++;
          this.logger.info('summarization-completed', { project });

          // Invalidate cache for this project
          this.cache.delete(`summary:${project}`);

          resolve({ ok: true });
        } else {
          this.stats.summarizationsFailed++;
          this.logger.error('summarization-failed', { project, exitCode: code });
          reject(new Error(`Summarization failed with code ${code}`));
        }
      });

      child.on('error', (err) => {
        this.stats.summarizationsFailed++;
        this.logger.error('summarization-error', { project, error: err.message });
        reject(err);
      });
    });
  }

  /**
   * Get summary (cached or load from disk)
   */
  getSummary(project) {
    // Try cache first
    const cacheKey = `summary:${project}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { summary: cached, cached: true };
    }

    // Load from disk
    const projectDir = this.getProjectDir(project);
    const summaryFile = join(projectDir, 'summary.json');

    if (!existsSync(summaryFile)) {
      return { summary: null, cached: false };
    }

    try {
      const summary = JSON.parse(readFileSync(summaryFile, 'utf-8'));

      // Cache it
      this.cache.set(cacheKey, summary);

      return { summary, cached: false };
    } catch (err) {
      this.logger.error('summary-read-failed', { project, error: err.message });
      return { summary: null, cached: false };
    }
  }

  /**
   * Get summarization status for a project
   */
  getStatus(project) {
    const running = this.running.has(project);
    const throttled = this.throttler.isThrottled(project);
    const retryAfterMs = this.throttler.getRetryAfter(project);

    let lastRun = null;
    const projectDir = this.getProjectDir(project);
    const summaryFile = join(projectDir, 'summary.json');
    if (existsSync(summaryFile)) {
      try {
        const summary = JSON.parse(readFileSync(summaryFile, 'utf-8'));
        lastRun = summary.lastUpdated || null;
      } catch {
        // Ignore
      }
    }

    return {
      running,
      throttled,
      retryAfterMs,
      lastRun
    };
  }

  /**
   * Get service stats
   */
  getStats() {
    return {
      ...this.stats,
      cacheStats: this.cache.getStats(),
      runningCount: this.running.size
    };
  }

  /**
   * Shutdown service
   */
  async shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Wait for running summarizations to complete (with timeout)
    const promises = Array.from(this.running.values());
    if (promises.length > 0) {
      this.logger.info('summarization-shutdown-wait', { count: promises.length });
      await Promise.race([
        Promise.all(promises),
        new Promise(r => setTimeout(r, 5000)) // 5s timeout
      ]);
    }
  }
}
