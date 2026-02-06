#!/usr/bin/env node
/**
 * Plugin Health Check Script
 *
 * Checks the status of the claude-mneme plugin:
 * - Config validity
 * - Claude binary availability
 * - Memory directories
 * - Recent errors
 * - Summary and log status
 *
 * Usage: node mem-status.mjs [--clear-errors]
 */

import { existsSync, readFileSync, statSync, accessSync, constants } from 'fs';
import { execFileSync } from 'child_process';
import {
  MEMORY_BASE,
  CONFIG_FILE,
  ensureMemoryDirs,
  loadConfig,
  getProjectName,
  getRecentErrors,
  getErrorsSince,
  clearErrorLog,
  getErrorLogPath
} from './utils.mjs';

const cwd = process.cwd();
const clearErrors = process.argv.includes('--clear-errors');

// Clear errors if requested
if (clearErrors) {
  const cleared = clearErrorLog();
  console.log(JSON.stringify({
    action: 'clear_errors',
    success: cleared
  }));
  process.exit(0);
}

const status = {
  project: getProjectName(cwd),
  timestamp: new Date().toISOString(),
  overall: 'healthy', // Will be downgraded if issues found
  checks: {},
  errors: [],
  warnings: []
};

// ============================================================================
// Check 1: Config
// ============================================================================
try {
  const config = loadConfig();
  status.checks.config = {
    status: 'ok',
    path: CONFIG_FILE,
    exists: existsSync(CONFIG_FILE),
    model: config.model || 'haiku',
    maxLogEntries: config.maxLogEntriesBeforeSummarize || 50
  };

  // Check for potentially problematic settings
  // Only warn about claudePath if it looks like an absolute path that doesn't exist
  if (config.claudePath && config.claudePath.startsWith('/') && !existsSync(config.claudePath)) {
    status.checks.config.warning = `claudePath "${config.claudePath}" does not exist`;
    status.warnings.push(`Config: claudePath not found at ${config.claudePath}`);
  }
} catch (err) {
  status.checks.config = { status: 'error', message: err.message };
  status.errors.push(`Config: ${err.message}`);
  status.overall = 'unhealthy';
}

// ============================================================================
// Check 2: Claude Binary
// ============================================================================
try {
  const config = loadConfig();
  let claudePath = config.claudePath || 'claude';

  // Try to find claude in PATH if not specified
  try {
    const result = execFileSync('which', [claudePath.split('/').pop()], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    if (result) {
      status.checks.claudeBinary = {
        status: 'ok',
        path: result,
        configured: config.claudePath || '(using PATH)'
      };
    }
  } catch {
    // which failed, try the configured path directly
    if (config.claudePath && existsSync(config.claudePath)) {
      status.checks.claudeBinary = {
        status: 'ok',
        path: config.claudePath,
        configured: config.claudePath
      };
    } else {
      status.checks.claudeBinary = {
        status: 'error',
        message: 'Claude binary not found in PATH or at configured claudePath'
      };
      status.errors.push('Claude binary not found - summarization will fail');
      status.overall = 'unhealthy';
    }
  }
} catch (err) {
  status.checks.claudeBinary = { status: 'error', message: err.message };
  status.errors.push(`Claude binary: ${err.message}`);
  status.overall = 'unhealthy';
}

// ============================================================================
// Check 3: Memory Directories
// ============================================================================
try {
  const paths = ensureMemoryDirs(cwd);

  // Check base directory
  const baseWritable = checkWritable(MEMORY_BASE);

  // Check project directory
  const projectWritable = checkWritable(paths.project);

  status.checks.directories = {
    status: baseWritable && projectWritable ? 'ok' : 'error',
    base: {
      path: MEMORY_BASE,
      exists: existsSync(MEMORY_BASE),
      writable: baseWritable
    },
    project: {
      path: paths.project,
      exists: existsSync(paths.project),
      writable: projectWritable
    }
  };

  if (!baseWritable || !projectWritable) {
    status.errors.push('Memory directories not writable');
    status.overall = 'unhealthy';
  }
} catch (err) {
  status.checks.directories = { status: 'error', message: err.message };
  status.errors.push(`Directories: ${err.message}`);
  status.overall = 'unhealthy';
}

// ============================================================================
// Check 4: Memory Files Status
// ============================================================================
try {
  const paths = ensureMemoryDirs(cwd);

  const logExists = existsSync(paths.log);
  const logEntries = logExists ? countLines(paths.log) : 0;

  const summaryJsonExists = existsSync(paths.summaryJson);
  const summaryMdExists = existsSync(paths.summary);

  const rememberedExists = existsSync(paths.remembered);
  let rememberedCount = 0;
  if (rememberedExists) {
    try {
      const content = readFileSync(paths.remembered, 'utf-8');
      rememberedCount = JSON.parse(content).length;
    } catch {}
  }

  const entitiesExists = existsSync(paths.entities);

  status.checks.memoryFiles = {
    status: 'ok',
    log: {
      exists: logExists,
      entries: logEntries,
      needsSummarization: logEntries >= (loadConfig().maxLogEntriesBeforeSummarize || 50)
    },
    summary: {
      jsonExists: summaryJsonExists,
      mdExists: summaryMdExists,
      lastUpdated: summaryJsonExists ? getFileAge(paths.summaryJson) : null
    },
    remembered: {
      exists: rememberedExists,
      count: rememberedCount
    },
    entities: {
      exists: entitiesExists
    }
  };

  // Warning if log needs summarization
  if (status.checks.memoryFiles.log.needsSummarization) {
    status.warnings.push(`Log has ${logEntries} entries - consider running /summarize`);
  }
} catch (err) {
  status.checks.memoryFiles = { status: 'error', message: err.message };
  status.errors.push(`Memory files: ${err.message}`);
}

// ============================================================================
// Check 5: Recent Errors
// ============================================================================
try {
  const recentErrors = getErrorsSince(24); // Last 24 hours
  const allErrors = getRecentErrors(5); // Last 5 errors regardless of time

  status.checks.errorLog = {
    status: recentErrors.length === 0 ? 'ok' : 'warning',
    path: getErrorLogPath(),
    errorsLast24h: recentErrors.length,
    recentErrors: allErrors.map(e => ({
      time: e.ts,
      context: e.context,
      message: e.message
    }))
  };

  if (recentErrors.length > 0) {
    status.warnings.push(`${recentErrors.length} error(s) in the last 24 hours`);
    if (status.overall === 'healthy') {
      status.overall = 'degraded';
    }
  }
} catch (err) {
  status.checks.errorLog = { status: 'error', message: err.message };
}

// ============================================================================
// Check 6: Sync Configuration (if enabled)
// ============================================================================
try {
  const config = loadConfig();
  const syncConfig = config.sync || {};

  if (syncConfig.enabled) {
    status.checks.sync = {
      status: 'configured',
      serverUrl: syncConfig.serverUrl,
      hasApiKey: !!syncConfig.apiKey
    };

    // Try to reach the server
    if (syncConfig.serverUrl) {
      // We can't easily do async HTTP here, so just note it's configured
      status.checks.sync.note = 'Server reachability not checked (use session-start to verify)';
    }
  } else {
    status.checks.sync = {
      status: 'disabled',
      note: 'Local-only mode (default)'
    };
  }
} catch (err) {
  status.checks.sync = { status: 'error', message: err.message };
}

// ============================================================================
// Output
// ============================================================================

// Set overall status based on errors/warnings
if (status.errors.length > 0) {
  status.overall = 'unhealthy';
} else if (status.warnings.length > 0) {
  status.overall = 'degraded';
}

console.log(JSON.stringify(status, null, 2));

// ============================================================================
// Helper Functions
// ============================================================================

function checkWritable(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function countLines(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return 0;
    return content.split('\n').filter(l => l).length;
  } catch {
    return 0;
  }
}

function getFileAge(filePath) {
  try {
    const stat = statSync(filePath);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageHours = Math.round(ageMs / (1000 * 60 * 60) * 10) / 10;
    if (ageHours < 1) {
      const ageMinutes = Math.round(ageMs / (1000 * 60));
      return `${ageMinutes} minutes ago`;
    } else if (ageHours < 24) {
      return `${ageHours} hours ago`;
    } else {
      const ageDays = Math.round(ageHours / 24 * 10) / 10;
      return `${ageDays} days ago`;
    }
  } catch {
    return 'unknown';
  }
}
