import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { truncateLogSafely } from './mem-summarize.mjs';

describe('truncateLogSafely', () => {
  it('preserves entries appended while waiting on the log write lock', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'mneme-mem-summarize-'));
    mkdirSync(projectDir, { recursive: true });

    const logPath = join(projectDir, 'log.jsonl');
    const writeLockPath = `${logPath}.wlock`;

    writeFileSync(logPath, [
      JSON.stringify({ type: 'prompt', content: 'first' }),
      JSON.stringify({ type: 'response', content: 'second' }),
      JSON.stringify({ type: 'prompt', content: 'third' })
    ].join('\n') + '\n');

    writeFileSync(writeLockPath, 'busy');

    setTimeout(() => {
      writeFileSync(logPath, [
        JSON.stringify({ type: 'prompt', content: 'first' }),
        JSON.stringify({ type: 'response', content: 'second' }),
        JSON.stringify({ type: 'prompt', content: 'third' }),
        JSON.stringify({ type: 'response', content: 'arrived later' })
      ].join('\n') + '\n');
      rmSync(writeLockPath, { force: true });
    }, 20);

    const keptCount = await truncateLogSafely({
      logPath,
      summarizeCount: 3,
      staleSec: 30,
      retryDelayMs: 10,
      timeoutMs: 500
    });

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(keptCount, 1);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('arrived later'));
  });
});
