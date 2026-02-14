#!/usr/bin/env node
/**
 * Tests for SummarizationService
 *
 * Verifies script path resolution and isNeeded threshold logic.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { SUMMARIZE_SCRIPT, SummarizationService } from './summarization-service.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal logger stub
const nullLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe('SUMMARIZE_SCRIPT path resolution', () => {
  it('resolves to an absolute path', () => {
    assert.ok(isAbsolute(SUMMARIZE_SCRIPT), `Expected absolute path, got: ${SUMMARIZE_SCRIPT}`);
  });

  it('points to an existing file', () => {
    assert.ok(existsSync(SUMMARIZE_SCRIPT),
      `summarize.mjs not found at ${SUMMARIZE_SCRIPT} — path resolution is broken`);
  });

  it('is independent of process.cwd()', () => {
    const serverDir = __dirname;
    const expectedBase = dirname(serverDir); // plugin root (one level up from server/)
    assert.ok(SUMMARIZE_SCRIPT.startsWith(expectedBase),
      `Expected path under ${expectedBase}, got: ${SUMMARIZE_SCRIPT}`);
    assert.ok(SUMMARIZE_SCRIPT.endsWith('scripts/summarize.mjs'),
      `Expected path ending with scripts/summarize.mjs, got: ${SUMMARIZE_SCRIPT}`);
  });
});

describe('SummarizationService.isNeeded', () => {
  const tmpDir = join(__dirname, '..', '.test-summarization-tmp');
  const projectDir = join(tmpDir, 'test-project');
  let service;

  function createService(config = {}) {
    service = new SummarizationService(
      { summarization: { entryThreshold: 50, ...config } },
      nullLogger,
      () => projectDir
    );
    return service;
  }

  function writeLogEntries(count) {
    const logFile = join(projectDir, 'log.jsonl');
    const entries = Array.from({ length: count }, (_, i) =>
      JSON.stringify({ ts: new Date().toISOString(), type: 'prompt', content: `entry ${i}` })
    ).join('\n');
    writeFileSync(logFile, entries);
  }

  afterEach(async () => {
    if (service) {
      await service.shutdown();
      service = null;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when no log file exists', () => {
    mkdirSync(projectDir, { recursive: true });
    createService();
    assert.equal(service.isNeeded('test'), false);
  });

  it('returns false when entries are below threshold', () => {
    mkdirSync(projectDir, { recursive: true });
    writeLogEntries(10);
    createService();
    assert.equal(service.isNeeded('test'), false);
  });

  it('returns true when entries meet threshold', () => {
    mkdirSync(projectDir, { recursive: true });
    writeLogEntries(50);
    createService();
    assert.equal(service.isNeeded('test'), true);
  });

  it('subtracts lastEntryIndex from count', () => {
    mkdirSync(projectDir, { recursive: true });
    writeLogEntries(60);
    writeFileSync(join(projectDir, 'summary.json'), JSON.stringify({ lastEntryIndex: 40 }));
    createService();
    // 60 entries, 40 already summarized → 20 new → below threshold
    assert.equal(service.isNeeded('test'), false);
  });

  it('returns true when new entries since last summary exceed threshold', () => {
    mkdirSync(projectDir, { recursive: true });
    writeLogEntries(100);
    writeFileSync(join(projectDir, 'summary.json'), JSON.stringify({ lastEntryIndex: 40 }));
    createService();
    // 100 entries, 40 summarized → 60 new → above threshold of 50
    assert.equal(service.isNeeded('test'), true);
  });
});
