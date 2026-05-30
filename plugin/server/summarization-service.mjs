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
import { getLogEntryCount } from '../lib/log-metadata.mjs';

function createTimingStats() {
  return { count: 0, totalMs: 0, maxMs: 0, metadataHits: 0, rescans: 0 };
}

function recordTiming(stats, durationMs, { fromMetadata = false } = {}) {
  stats.count++;
  stats.totalMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);
  if (fromMetadata) {
    stats.metadataHits++;
  } else {
    stats.rescans++;
  }
}

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
    this.pendingRetrigger = new Set(); // projects with a scheduled re-check
    this.stats = {
      summarizationsStarted: 0,
      summarizationsCompleted: 0,
      summarizationsFailed: 0,
      throttled: 0,
      timings: {
        thresholdCheckMs: createTimingStats()
      }
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

    let ticket;
    try {
      ticket = this.throttler.start(project);
    } catch (err) {
      if (err instanceof ThrottleError) {
        this.stats.throttled++;
        // Don't silently drop the trigger — a burst of entries within the
        // cooldown would otherwise never summarize until the next hook event.
        // Re-check once the cooldown elapses.
        this._scheduleRetrigger(project, err.retryAfterMs);
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

    const promise = this.runSummarization(project)
      .then((result) => {
        ticket.success();
        return result;
      })
      .catch((err) => {
        ticket.failure();
        throw err;
      });

    this.running.set(project, promise);
    promise.then(
      () => this.running.delete(project),
      () => this.running.delete(project)
    );
    promise.catch(() => {});

    this.stats.summarizationsStarted++;

    return {
      ok: true,
      queued: true,
      running: false
    };
  }

  /**
   * Schedule a single deferred re-trigger for a throttled project, so a burst
   * of entries during the cooldown still gets summarized once it elapses.
   */
  _scheduleRetrigger(project, retryAfterMs) {
    if (this.pendingRetrigger.has(project)) return;
    this.pendingRetrigger.add(project);
    const timer = setTimeout(() => {
      this.pendingRetrigger.delete(project);
      // trigger() re-checks throttle + isNeeded and no-ops if nothing to do.
      this.trigger(project, false).catch(() => {});
    }, Math.max(1000, (retryAfterMs || this.throttler.cooldownMs || 30000) + 100));
    if (typeof timer.unref === 'function') timer.unref();
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

    const startedAt = Date.now();
    const { entryCount, fromMetadata } = getLogEntryCount(logFile, {
      logErrorFn: (err, context) => this.logger.error('summarization-log-metadata-failed', {
        project,
        context,
        error: err.message
      })
    });
    recordTiming(this.stats.timings.thresholdCheckMs, Date.now() - startedAt, { fromMetadata });

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

    const newEntries = entryCount - lastSummarizedCount;
    // summarize.mjs gates on maxLogEntriesBeforeSummarize; keep the server's
    // threshold aligned with it (entryThreshold kept as a back-compat override).
    const threshold = this.config.summarization?.entryThreshold
      || this.config.maxLogEntriesBeforeSummarize
      || 50;

    return newEntries >= threshold;
  }

  /**
   * Run summarization (spawns summarize.mjs script)
   */
  async runSummarization(project) {
    const projectDir = this.getProjectDir(project);

    this.logger.info('summarization-started', { project });

    return new Promise((resolve, reject) => {
      // Don't inherit stdio: the server runs detached, so 'inherit' sends the
      // child's stderr to /dev/null (hiding all summarization failures).
      // Capture it and surface it through the logger instead.
      const child = spawn('node', [
        SUMMARIZE_SCRIPT,
        projectDir
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stderrBuf = '';
      child.stderr?.on('data', (d) => { stderrBuf += d.toString(); });

      child.on('exit', (code) => {
        if (code === 0) {
          this.stats.summarizationsCompleted++;
          this.logger.info('summarization-completed', { project });

          // Invalidate cache for this project
          this.cache.delete(`summary:${project}`);

          resolve({ ok: true });
        } else {
          this.stats.summarizationsFailed++;
          this.logger.error('summarization-failed', { project, exitCode: code, stderr: stderrBuf.slice(0, 1000) });
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
    const thresholdTiming = this.stats.timings.thresholdCheckMs;
    return {
      ...this.stats,
      cacheStats: this.cache.getStats(),
      runningCount: this.running.size,
      timings: {
        thresholdCheckMs: {
          ...thresholdTiming,
          avgMs: thresholdTiming.count > 0 ? thresholdTiming.totalMs / thresholdTiming.count : 0
        }
      }
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
