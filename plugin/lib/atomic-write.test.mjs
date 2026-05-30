import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

test('writeFileAtomic writes the file and content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mneme-atomic-'));
  try {
    const p = join(dir, 'out.json');
    writeFileAtomic(p, '{"a":1}\n');
    assert.equal(readFileSync(p, 'utf-8'), '{"a":1}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic creates missing parent directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mneme-atomic-'));
  try {
    const p = join(dir, 'nested', 'deep', 'out.txt');
    writeFileAtomic(p, 'hello');
    assert.equal(readFileSync(p, 'utf-8'), 'hello');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic overwrites atomically and leaves no temp files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mneme-atomic-'));
  try {
    const p = join(dir, 'out.txt');
    writeFileAtomic(p, 'first');
    writeFileAtomic(p, 'second');
    assert.equal(readFileSync(p, 'utf-8'), 'second');
    const leftover = readdirSync(dir).filter(f => f.includes('.tmp'));
    assert.deepEqual(leftover, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic cleans up the temp file on write failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mneme-atomic-'));
  try {
    const p = join(dir, 'out.txt');
    // A circular structure can't be serialized — but we pass a value that throws
    // during write by giving a non-string/Buffer with a toString that throws.
    const bad = { toString() { throw new Error('boom'); } };
    assert.throws(() => writeFileAtomic(p, bad));
    assert.ok(!existsSync(p));
    const leftover = readdirSync(dir).filter(f => f.includes('.tmp'));
    assert.deepEqual(leftover, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
