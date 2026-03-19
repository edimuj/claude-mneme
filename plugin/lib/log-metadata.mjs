import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { dirname, join } from 'path';

const LOG_METADATA_FILE = 'log.meta.json';

export function getLogMetadataPath(logPath) {
  return join(dirname(logPath), LOG_METADATA_FILE);
}

export function getLogFileState(logPath) {
  if (!existsSync(logPath)) {
    return { size: 0, mtimeMs: 0 };
  }

  const stats = statSync(logPath);
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}

export function readLogMetadata(logPath, logErrorFn = null) {
  const metadataPath = getLogMetadataPath(logPath);
  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(metadataPath, 'utf-8'));
  } catch (err) {
    if (logErrorFn) {
      logErrorFn(err, 'readLogMetadata');
    }
    return null;
  }
}

export function writeLogMetadata(logPath, entryCount, fileState = getLogFileState(logPath), logErrorFn = null) {
  const metadataPath = getLogMetadataPath(logPath);
  const payload = {
    entryCount,
    size: fileState.size,
    mtimeMs: fileState.mtimeMs,
    updatedAt: new Date().toISOString()
  };

  try {
    writeFileSync(metadataPath, JSON.stringify(payload, null, 2) + '\n');
    return payload;
  } catch (err) {
    if (logErrorFn) {
      logErrorFn(err, 'writeLogMetadata');
    }
    return null;
  }
}

export function metadataMatchesFile(metadata, fileState) {
  return Boolean(
    metadata &&
    metadata.size === fileState.size &&
    metadata.mtimeMs === fileState.mtimeMs &&
    Number.isInteger(metadata.entryCount)
  );
}

export function scanLogEntryCount(logPath, readFileSyncFn = readFileSync) {
  if (!existsSync(logPath)) {
    return 0;
  }

  const content = readFileSyncFn(logPath, 'utf-8').trim();
  if (!content) {
    return 0;
  }

  return content.split('\n').filter(Boolean).length;
}

export function getLogEntryCount(logPath, options = {}) {
  const {
    logErrorFn = null,
    readFileSyncFn = readFileSync,
    fileState = getLogFileState(logPath)
  } = options;

  const metadata = readLogMetadata(logPath, logErrorFn);
  if (metadataMatchesFile(metadata, fileState)) {
    return {
      entryCount: metadata.entryCount,
      fromMetadata: true
    };
  }

  const entryCount = scanLogEntryCount(logPath, readFileSyncFn);
  writeLogMetadata(logPath, entryCount, fileState, logErrorFn);

  return {
    entryCount,
    fromMetadata: false
  };
}

export function updateLogMetadataAfterAppend(logPath, appendedCount, options = {}) {
  const {
    beforeState = getLogFileState(logPath),
    afterState = getLogFileState(logPath),
    logErrorFn = null
  } = options;

  const metadata = readLogMetadata(logPath, logErrorFn);
  if (metadataMatchesFile(metadata, beforeState)) {
    writeLogMetadata(logPath, metadata.entryCount + appendedCount, afterState, logErrorFn);
    return { scanned: false };
  }

  const entryCount = beforeState.size === 0
    ? appendedCount
    : scanLogEntryCount(logPath);

  writeLogMetadata(logPath, entryCount, afterState, logErrorFn);
  return { scanned: beforeState.size > 0 };
}
