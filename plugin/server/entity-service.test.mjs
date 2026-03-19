import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EntityService } from './entity-service.mjs';

const nullLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe('EntityService', () => {
  it('updates entities.json once per batch and reports timing stats', () => {
    const root = mkdtempSync(join(tmpdir(), 'mneme-entity-service-'));
    const projectDir = join(root, 'project');
    mkdirSync(projectDir, { recursive: true });

    const service = new EntityService(
      { entityExtraction: { enabled: true } },
      nullLogger,
      () => projectDir
    );

    service.processEntries('/tmp/project', [
      { ts: new Date().toISOString(), type: 'response', content: 'Updated src/auth.ts' },
      { ts: new Date().toISOString(), type: 'response', content: 'Touched src/auth.ts and parseToken' },
      { ts: new Date().toISOString(), type: 'response', content: 'ReferenceError: auth failed' }
    ]);

    const stats = service.getStats();
    assert.equal(stats.batchesProcessed, 1);
    assert.equal(stats.indexLoads, 1);
    assert.equal(stats.indexWrites, 1);
    assert.ok(stats.entitiesExtracted >= 3);
    assert.equal(stats.timings.batchUpdateMs.count, 1);
    assert.ok(stats.timings.batchUpdateMs.maxMs >= 0);

    const index = JSON.parse(readFileSync(join(projectDir, 'entities.json'), 'utf-8'));
    assert.ok(index.files['src/auth.ts']);
  });
});
