import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getLogMetadataPath,
  getLogFileState,
  readLogMetadata,
  writeLogMetadata,
  metadataMatchesFile,
  scanLogEntryCount,
  getLogEntryCount,
  updateLogMetadataAfterAppend,
} from './log-metadata.mjs';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'mneme-logmeta-'));
}

function writeLog(dir, lines) {
  const logPath = join(dir, 'log.jsonl');
  writeFileSync(logPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return logPath;
}

// ---------------------------------------------------------------------------
// getLogMetadataPath
// ---------------------------------------------------------------------------

describe('getLogMetadataPath', () => {
  it('returns sibling log.meta.json', () => {
    assert.equal(getLogMetadataPath('/foo/bar/log.jsonl'), '/foo/bar/log.meta.json');
  });
});

// ---------------------------------------------------------------------------
// getLogFileState
// ---------------------------------------------------------------------------

describe('getLogFileState', () => {
  it('returns zero state for missing file', () => {
    const state = getLogFileState('/nonexistent/file.jsonl');
    assert.equal(state.size, 0);
    assert.equal(state.mtimeMs, 0);
  });

  it('returns real stats for existing file', () => {
    const dir = makeTmpDir();
    const logPath = join(dir, 'log.jsonl');
    writeFileSync(logPath, '{"a":1}\n');
    const state = getLogFileState(logPath);
    assert.ok(state.size > 0);
    assert.ok(state.mtimeMs > 0);
  });
});

// ---------------------------------------------------------------------------
// readLogMetadata / writeLogMetadata
// ---------------------------------------------------------------------------

describe('readLogMetadata', () => {
  it('returns null when no metadata file exists', () => {
    assert.equal(readLogMetadata('/nonexistent/log.jsonl'), null);
  });

  it('returns null and calls logError on corrupt file', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'log.meta.json'), '{corrupt');
    let errorLogged = false;
    const result = readLogMetadata(join(dir, 'log.jsonl'), () => { errorLogged = true; });
    assert.equal(result, null);
    assert.ok(errorLogged);
  });
});

describe('writeLogMetadata', () => {
  it('writes metadata and returns payload', () => {
    const dir = makeTmpDir();
    const logPath = join(dir, 'log.jsonl');
    writeFileSync(logPath, '{"a":1}\n');
    const state = getLogFileState(logPath);
    const result = writeLogMetadata(logPath, 1, state);
    assert.equal(result.entryCount, 1);
    assert.equal(result.size, state.size);
    assert.ok(result.updatedAt);
    // Verify it's readable
    const loaded = readLogMetadata(logPath);
    assert.equal(loaded.entryCount, 1);
  });

  it('returns null and calls logError on write failure', () => {
    let errorLogged = false;
    const result = writeLogMetadata('/nonexistent/dir/log.jsonl', 5, { size: 0, mtimeMs: 0 }, () => { errorLogged = true; });
    assert.equal(result, null);
    assert.ok(errorLogged);
  });
});

// ---------------------------------------------------------------------------
// metadataMatchesFile
// ---------------------------------------------------------------------------

describe('metadataMatchesFile', () => {
  it('matches when size and mtime are equal', () => {
    assert.ok(metadataMatchesFile({ size: 100, mtimeMs: 500, entryCount: 3 }, { size: 100, mtimeMs: 500 }));
  });

  it('rejects when size differs', () => {
    assert.ok(!metadataMatchesFile({ size: 100, mtimeMs: 500, entryCount: 3 }, { size: 200, mtimeMs: 500 }));
  });

  it('rejects when mtime differs', () => {
    assert.ok(!metadataMatchesFile({ size: 100, mtimeMs: 500, entryCount: 3 }, { size: 100, mtimeMs: 600 }));
  });

  it('rejects when metadata is null', () => {
    assert.ok(!metadataMatchesFile(null, { size: 100, mtimeMs: 500 }));
  });

  it('rejects when entryCount is not integer', () => {
    assert.ok(!metadataMatchesFile({ size: 100, mtimeMs: 500, entryCount: 'foo' }, { size: 100, mtimeMs: 500 }));
  });
});

// ---------------------------------------------------------------------------
// scanLogEntryCount
// ---------------------------------------------------------------------------

describe('scanLogEntryCount', () => {
  it('returns 0 for missing file', () => {
    assert.equal(scanLogEntryCount('/nonexistent/log.jsonl'), 0);
  });

  it('returns 0 for empty file', () => {
    const dir = makeTmpDir();
    const logPath = join(dir, 'log.jsonl');
    writeFileSync(logPath, '');
    assert.equal(scanLogEntryCount(logPath), 0);
  });

  it('counts non-empty lines', () => {
    const dir = makeTmpDir();
    const logPath = join(dir, 'log.jsonl');
    writeFileSync(logPath, '{"a":1}\n{"b":2}\n{"c":3}\n');
    assert.equal(scanLogEntryCount(logPath), 3);
  });

  it('ignores empty lines', () => {
    const dir = makeTmpDir();
    const logPath = join(dir, 'log.jsonl');
    writeFileSync(logPath, '{"a":1}\n\n{"b":2}\n\n');
    assert.equal(scanLogEntryCount(logPath), 2);
  });
});

// ---------------------------------------------------------------------------
// getLogEntryCount
// ---------------------------------------------------------------------------

describe('getLogEntryCount', () => {
  it('scans on first call and writes metadata', () => {
    const dir = makeTmpDir();
    const logPath = writeLog(dir, [{ a: 1 }, { b: 2 }]);
    const result = getLogEntryCount(logPath);
    assert.equal(result.entryCount, 2);
    assert.equal(result.fromMetadata, false);
    // Metadata should now exist
    assert.ok(existsSync(getLogMetadataPath(logPath)));
  });

  it('returns from metadata on second call (cache hit)', () => {
    const dir = makeTmpDir();
    const logPath = writeLog(dir, [{ a: 1 }, { b: 2 }, { c: 3 }]);
    getLogEntryCount(logPath); // first call writes metadata
    const result = getLogEntryCount(logPath); // second call uses metadata
    assert.equal(result.entryCount, 3);
    assert.equal(result.fromMetadata, true);
  });

  it('re-scans when file changes after metadata write', () => {
    const dir = makeTmpDir();
    const logPath = writeLog(dir, [{ a: 1 }]);
    getLogEntryCount(logPath); // writes metadata for 1 entry
    // Modify the file
    writeFileSync(logPath, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const result = getLogEntryCount(logPath);
    assert.equal(result.entryCount, 3);
    assert.equal(result.fromMetadata, false);
  });
});

// ---------------------------------------------------------------------------
// updateLogMetadataAfterAppend
// ---------------------------------------------------------------------------

describe('updateLogMetadataAfterAppend', () => {
  it('increments existing metadata count (no scan)', () => {
    const dir = makeTmpDir();
    const logPath = writeLog(dir, [{ a: 1 }, { b: 2 }]);
    const beforeState = getLogFileState(logPath);
    // Write metadata matching beforeState
    writeLogMetadata(logPath, 2, beforeState);
    // Simulate appending 3 entries
    writeFileSync(logPath, '{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n{"e":5}\n');
    const afterState = getLogFileState(logPath);
    const result = updateLogMetadataAfterAppend(logPath, 3, { beforeState, afterState });
    assert.equal(result.scanned, false);
    // Check metadata was updated to 5
    const meta = readLogMetadata(logPath);
    assert.equal(meta.entryCount, 5);
  });

  it('scans when metadata does not match (stale)', () => {
    const dir = makeTmpDir();
    const logPath = writeLog(dir, [{ a: 1 }, { b: 2 }, { c: 3 }]);
    // No metadata written — stale
    const beforeState = getLogFileState(logPath);
    const afterState = getLogFileState(logPath);
    const result = updateLogMetadataAfterAppend(logPath, 1, { beforeState, afterState });
    assert.equal(result.scanned, true);
  });

  it('handles fresh file (beforeState.size === 0)', () => {
    const dir = makeTmpDir();
    const logPath = join(dir, 'log.jsonl');
    const beforeState = { size: 0, mtimeMs: 0 };
    writeFileSync(logPath, '{"a":1}\n{"b":2}\n');
    const afterState = getLogFileState(logPath);
    const result = updateLogMetadataAfterAppend(logPath, 2, { beforeState, afterState });
    assert.equal(result.scanned, false);
    const meta = readLogMetadata(logPath);
    assert.equal(meta.entryCount, 2);
  });
});
