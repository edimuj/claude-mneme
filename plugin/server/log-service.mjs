/**
 * LogService
 *
 * Handles log entry batching, deduplication, and file writes.
 * Centralizes all file I/O to eliminate lock contention.
 */

import { existsSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BatchQueue } from './batch-queue.mjs';
import { Deduplicator } from './deduplicator.mjs';
import { getLogFileState, updateLogMetadataAfterAppend } from '../lib/log-metadata.mjs';

function createTimingStats() {
  return { count: 0, totalMs: 0, maxMs: 0 };
}

function recordTiming(stats, durationMs) {
  stats.count++;
  stats.totalMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);
}

export class LogService {
  constructor(config, logger, { onEntriesWritten } = {}) {
    this.config = config;
    this.logger = logger;
    this.onEntriesWritten = onEntriesWritten || null;
    this.deduplicator = new Deduplicator({ windowMs: 5000 });
    this.stats = {
      entriesReceived: 0,
      entriesDeduplicated: 0,
      entriesWritten: 0,
      batchesFlushed: 0,
      writeErrors: 0,
      metadataRescans: 0,
      timings: {
        flushMs: createTimingStats()
      }
    };

    // Create batch queue with processor
    this.queue = new BatchQueue({
      maxSize: config.batching?.log?.maxSize || 100,
      maxWaitMs: config.batching?.log?.maxWaitMs || 1000,
      processor: (batch) => this.processBatch(batch)
    });
  }

  /**
   * Append log entry (queues for batched write)
   */
  append(project, entry) {
    this.stats.entriesReceived++;

    // Deduplicate
    if (this.deduplicator.isDuplicate(project, entry)) {
      this.stats.entriesDeduplicated++;
      return { ok: true, deduplicated: true, queued: false };
    }

    // Queue for batched write
    this.queue.add({ project, entry });

    return { ok: true, deduplicated: false, queued: true };
  }

  /**
   * Force immediate flush
   */
  async flush(project = null) {
    await this.queue.flush();
    return { ok: true, entriesFlushed: this.stats.entriesWritten };
  }

  /**
   * Process a batch of entries (group by project and write)
   */
  async processBatch(items) {
    const startedAt = Date.now();
    // Group by project
    const byProject = new Map();
    for (const { project, entry } of items) {
      if (!byProject.has(project)) {
        byProject.set(project, []);
      }
      byProject.get(project).push(entry);
    }

    // Write to each project's log file, then notify server per-project
    for (const [project, entries] of byProject) {
      try {
        this.writeToLog(project, entries);
        this.stats.entriesWritten += entries.length;

        // Notify server with project + entries for post-write processing
        if (this.onEntriesWritten) {
          try { this.onEntriesWritten(project, entries); } catch {}
        }
      } catch (err) {
        this.stats.writeErrors++;
        this.logger.error('log-write-failed', {
          project,
          entryCount: entries.length,
          error: err.message
        });
      }
    }

    this.stats.batchesFlushed++;
    recordTiming(this.stats.timings.flushMs, Date.now() - startedAt);

    this.logger.debug('log-batch-flushed', {
      projects: byProject.size,
      totalEntries: items.length,
      batchNum: this.stats.batchesFlushed
    });
  }

  /**
   * Write entries to project log file
   */
  writeToLog(project, entries) {
    const projectDir = this.getProjectMemoryDir(project);
    const logFile = join(projectDir, 'log.jsonl');

    // Ensure directory exists
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }

    // Prepare log lines
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    const beforeState = getLogFileState(logFile);

    // Single atomic write (no locking needed — we're the only writer)
    appendFileSync(logFile, lines);
    const afterState = getLogFileState(logFile);

    const metadataResult = updateLogMetadataAfterAppend(logFile, entries.length, {
      beforeState,
      afterState,
      logErrorFn: (err, context) => this.logger.error('log-metadata-failed', {
        project,
        context,
        error: err.message
      })
    });

    if (metadataResult.scanned) {
      this.stats.metadataRescans++;
    }
  }

  /**
   * Get project memory directory path
   */
  getProjectMemoryDir(project) {
    // Convert absolute path to safe dirname: /home/foo/bar → -home-foo-bar
    const safeName = project.replace(/^\//, '-').replace(/\//g, '-');
    const memoryBase = homedir() + '/.claude-mneme';
    return join(memoryBase, 'projects', safeName);
  }

  /**
   * Get queue depth
   */
  queueDepth() {
    return this.queue.depth();
  }

  /**
   * Get stats
   */
  getStats() {
    const flushTiming = this.stats.timings.flushMs;
    return {
      ...this.stats,
      queueDepth: this.queue.depth(),
      deduplicatorSize: this.deduplicator.size(),
      timings: {
        flushMs: {
          ...flushTiming,
          avgMs: flushTiming.count > 0 ? flushTiming.totalMs / flushTiming.count : 0
        }
      }
    };
  }

  /**
   * Shutdown service
   */
  async shutdown() {
    await this.queue.shutdown();
    this.deduplicator.shutdown();
  }
}
