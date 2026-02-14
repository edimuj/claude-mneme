/**
 * EntityService
 *
 * Server-side entity extraction and indexing.
 * Processes log entries to maintain entities.json per project.
 * No file locking needed — the server is the single writer.
 */

import { extractEntitiesFromEntry, loadEntityIndex, updateEntityIndex } from '../lib/entities.mjs';

export class EntityService {
  constructor(config, logger, getProjectDir) {
    this.config = config;
    this.logger = logger;
    this.getProjectDir = getProjectDir;
    this.stats = {
      entriesProcessed: 0,
      entitiesExtracted: 0,
      writeErrors: 0
    };
  }

  /**
   * Process a batch of entries for a project — extract entities and update index.
   */
  processEntries(project, entries) {
    const projectDir = this.getProjectDir(project);
    const eeConfig = this.config.entityExtraction || {};

    if (eeConfig.enabled === false) return;

    for (const entry of entries) {
      try {
        updateEntityIndex(entry, projectDir, this.config, {
          logErrorFn: (err, ctx) => this.logger.error('entity-update-error', {
            project, context: ctx, error: err.message
          })
          // No withFileLockFn — server is single writer
        });
        this.stats.entriesProcessed++;

        const extracted = extractEntitiesFromEntry(entry, eeConfig);
        this.stats.entitiesExtracted += Object.values(extracted).reduce((sum, arr) => sum + arr.length, 0);
      } catch (err) {
        this.stats.writeErrors++;
        this.logger.error('entity-process-error', {
          project,
          error: err.message
        });
      }
    }

    this.logger.debug('entities-processed', {
      project,
      entryCount: entries.length,
      totalProcessed: this.stats.entriesProcessed
    });
  }

  getStats() {
    return { ...this.stats };
  }
}
