/**
 * EntityService
 *
 * Server-side entity extraction and indexing.
 * Processes log entries to maintain entities.json per project.
 * No file locking needed — the server is the single writer.
 */

import { updateEntityIndexBatch } from '../lib/entities.mjs';

function createTimingStats() {
  return { count: 0, totalMs: 0, maxMs: 0 };
}

function recordTiming(stats, durationMs) {
  stats.count++;
  stats.totalMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);
}

export class EntityService {
  constructor(config, logger, getProjectDir) {
    this.config = config;
    this.logger = logger;
    this.getProjectDir = getProjectDir;
    this.stats = {
      entriesProcessed: 0,
      batchesProcessed: 0,
      entitiesExtracted: 0,
      indexLoads: 0,
      indexWrites: 0,
      writeErrors: 0,
      timings: {
        batchUpdateMs: createTimingStats()
      }
    };
  }

  /**
   * Process a batch of entries for a project — extract entities and update index.
   */
  processEntries(project, entries) {
    const projectDir = this.getProjectDir(project);
    const eeConfig = this.config.entityExtraction || {};

    if (eeConfig.enabled === false) return;

    const startedAt = Date.now();

    try {
      const result = updateEntityIndexBatch(entries, projectDir, this.config, {
        logErrorFn: (err, ctx) => this.logger.error('entity-update-error', {
          project, context: ctx, error: err.message
        })
      });

      this.stats.entriesProcessed += result.processedEntries;
      this.stats.entitiesExtracted += result.entitiesExtracted;
      this.stats.indexLoads += result.reads;
      this.stats.indexWrites += result.writes;
      this.stats.batchesProcessed++;
      recordTiming(this.stats.timings.batchUpdateMs, Date.now() - startedAt);
    } catch (err) {
      this.stats.writeErrors++;
      this.logger.error('entity-process-error', {
        project,
        error: err.message
      });
    }

    this.logger.debug('entities-processed', {
      project,
      entryCount: entries.length,
      totalProcessed: this.stats.entriesProcessed
    });
  }

  getStats() {
    const timing = this.stats.timings.batchUpdateMs;
    return {
      ...this.stats,
      timings: {
        batchUpdateMs: {
          ...timing,
          avgMs: timing.count > 0 ? timing.totalMs / timing.count : 0
        }
      }
    };
  }
}
