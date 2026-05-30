import { writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Atomically write data to a file.
 *
 * Writes to a unique temp sibling then renames over the target. rename(2) is
 * atomic on the same filesystem, so a crash/kill mid-write can never leave the
 * target partially written or truncated — readers always see either the old
 * complete file or the new complete file. The parent directory is created if
 * missing, and the temp file is cleaned up on failure.
 *
 * Callers that need read-modify-write mutual exclusion must still wrap the
 * whole operation in a lock; this only guarantees the write itself is atomic.
 */
export function writeFileAtomic(filePath, data, encoding = 'utf-8') {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data, encoding);
    renameSync(tmp, filePath);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}
