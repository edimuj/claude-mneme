/**
 * LogService
 *
 * Handles log entry batching, deduplication, and file writes.
 * Centralizes all file I/O to eliminate lock contention.
 */

import { existsSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { BatchQueue } from './batch-queue.mjs';
import { Deduplicator } from './deduplicator.mjs';

export class LogService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.deduplicator = new Deduplicator({ windowMs: 5000 });
    this.stats = {
      entriesReceived: 0,
      entriesDeduplicated: 0,
      entriesWritten: 0,
      batchesFlushed: 0,
      writeErrors: 0
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
    if (this.deduplicator.isDuplicate(entry)) {
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
    // Group by project
    const byProject = new Map();
    for (const { project, entry } of items) {
      if (!byProject.has(project)) {
        byProject.set(project, []);
      }
      byProject.get(project).push(entry);
    }

    // Write to each project's log file
    for (const [project, entries] of byProject) {
      try {
        this.writeToLog(project, entries);
        this.stats.entriesWritten += entries.length;
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

    // Single atomic write (no locking needed — we're the only writer)
    appendFileSync(logFile, lines);
  }

  /**
   * Get project memory directory path
   */
  getProjectMemoryDir(project) {
    // Hash project path for directory name (same as current implementation)
    const hash = createHash('sha256').update(project).digest('hex').slice(0, 16);
    const memoryBase = homedir() + '/.claude-mneme';
    return join(memoryBase, hash);
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
    return {
      ...this.stats,
      queueDepth: this.queue.depth(),
      deduplicatorSize: this.deduplicator.size()
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
