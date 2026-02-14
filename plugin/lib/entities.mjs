/**
 * Entity extraction and indexing — shared between hooks (client) and Plugin Service (server).
 *
 * Pure extraction functions have no I/O dependencies.
 * Index functions (load/update) take paths as arguments so both client and server can use them.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

export function extractFilePaths(entry, config = {}) {
  const content = entry.content || entry.subject || '';
  const paths = [];
  const allowedExtensions = config.fileExtensions || [
    'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'cpp', 'c', 'h',
    'css', 'scss', 'sass', 'less', 'html', 'vue', 'svelte', 'json', 'yaml', 'yml', 'md',
    'sql', 'sh', 'bash', 'zsh', 'toml', 'xml', 'graphql', 'prisma'
  ];
  const minLength = config.minEntityLength || 2;

  const patterns = [
    /(?:^|[\s"'`])([a-zA-Z0-9_\-.]+\/[a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})(?:[\s"'`:]|$)/g,
    /(?:file|in|from|to|edit|read|write|created|updated|modified)\s+[`"']?([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})[`"']?/gi,
    /`([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6})`/g,
    /(?:^|[\s"'`])([a-zA-Z][a-zA-Z0-9_\-]*\.(?:ts|js|tsx|jsx|mjs|py|go|rs|java|vue|svelte|md|json|yaml|yml))(?:[\s"'`:]|$)/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const path = match[1];
      if (path && path.length >= minLength && path.length < 100 && !paths.includes(path)) {
        const ext = path.split('.').pop()?.toLowerCase();
        if (ext && allowedExtensions.includes(ext)) {
          if (!isFileFalsePositive(path)) {
            paths.push(path);
          }
        }
      }
    }
  }

  return paths;
}

export function isFileFalsePositive(path) {
  const lower = path.toLowerCase();
  if (/^\d+\.\d+/.test(path)) return true;
  if (lower.startsWith('http') || lower.startsWith('www.')) return true;
  const falsePositives = ['property', 'of.undefined', 'read.property'];
  return falsePositives.some(fp => lower.includes(fp));
}

export function extractFunctionNames(entry, config = {}) {
  const content = entry.content || entry.subject || '';
  const functions = [];
  const minLength = config.minEntityLength || 3;

  const patterns = [
    /(?:function|const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]{2,})\s*(?:=\s*(?:async\s*)?\(|=\s*(?:async\s*)?function|\()/g,
    /`([a-zA-Z_$][a-zA-Z0-9_$]{2,})\s*\(`/g,
    /`([a-zA-Z_$][a-zA-Z0-9_$]{2,})\(\)`/g,
    /(?:function|method|handler|callback)\s+[`"']?([a-zA-Z_$][a-zA-Z0-9_$]*[A-Z_][a-zA-Z0-9_$]*)[`"']?/gi,
    /def\s+([a-zA-Z_][a-zA-Z0-9_]{2,})\s*\(/g,
  ];

  const exclude = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'break', 'continue',
    'new', 'typeof', 'instanceof', 'delete', 'void', 'throw', 'try', 'finally',
    'import', 'export', 'from', 'require', 'module', 'default', 'case',
    'class', 'extends', 'constructor', 'super', 'this', 'self', 'static',
    'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
    'async', 'await', 'yield', 'let', 'const', 'var', 'function',
    'console', 'window', 'document', 'process', 'global', 'module', 'exports',
    'Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON',
    'Promise', 'Error', 'Map', 'Set', 'RegExp', 'Function', 'Symbol', 'BigInt',
    'Buffer', 'Uint8Array', 'ArrayBuffer', 'DataView', 'Proxy', 'Reflect',
    'get', 'set', 'has', 'add', 'delete', 'clear', 'keys', 'values', 'entries',
    'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race', 'any',
    'log', 'error', 'warn', 'info', 'debug', 'trace', 'assert', 'dir', 'table',
    'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'flat',
    'map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every', 'includes', 'sort',
    'length', 'size', 'indexOf', 'lastIndexOf', 'replace', 'split', 'trim', 'match',
    'toString', 'valueOf', 'toJSON', 'toLocaleString', 'parse', 'stringify',
    'read', 'write', 'open', 'close', 'send', 'receive', 'emit', 'on', 'off',
    'start', 'stop', 'run', 'exec', 'call', 'apply', 'bind', 'create', 'destroy',
    'init', 'setup', 'cleanup', 'reset', 'update', 'render', 'mount', 'unmount',
    'was', 'the', 'not', 'and', 'for', 'are', 'but', 'can', 'has', 'had', 'did',
    'use', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  ]);

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (name && name.length >= minLength && name.length < 50 &&
          !functions.includes(name) && !exclude.has(name) && !exclude.has(name.toLowerCase())) {
        if (/[A-Z]/.test(name) || name.includes('_') || name.length >= 6) {
          functions.push(name);
        }
      }
    }
  }

  return functions;
}

export function extractErrorMessages(entry, config = {}) {
  const content = entry.content || entry.subject || '';
  const errors = [];
  const minLength = config.minEntityLength || 2;

  const patterns = [
    /\b((?:Type|Reference|Syntax|Range|URI|Eval|Internal|Aggregate)?Error):\s*([^\n.]{5,100})/g,
    /\b(Exception|Fault):\s*([^\n.]{5,100})/gi,
    /\berror:\s*([^\n.]{5,80})/gi,
    /\b(?:failed|failure):\s*([^\n.]{5,80})/gi,
    /^\s*at\s+([^\n]{10,100})/gm,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const errorMsg = match[2] ? `${match[1]}: ${match[2]}` : match[1];
      const cleaned = errorMsg.trim().slice(0, 100);
      if (cleaned.length >= minLength && !errors.includes(cleaned)) {
        errors.push(cleaned);
      }
    }
  }

  return errors;
}

export function extractPackageNames(entry, config = {}) {
  const content = entry.content || entry.subject || '';
  const packages = [];
  const minLength = config.minEntityLength || 2;

  const installMatch = content.match(/(?:npm|yarn|pnpm)\s+(?:install|add|i)\s+([^\n]+)/gi);
  if (installMatch) {
    for (const cmd of installMatch) {
      const pkgPart = cmd.replace(/^(?:npm|yarn|pnpm)\s+(?:install|add|i)\s+/i, '');
      const pkgNames = pkgPart.split(/\s+/).filter(p => p && !p.startsWith('-'));
      for (let name of pkgNames) {
        name = name.replace(/@[\d^~>=<.*]+$/, '');
        if (isValidPackageName(name, minLength)) {
          if (!packages.includes(name)) packages.push(name);
        }
      }
    }
  }

  const patterns = [
    /(?:import|from)\s+['"](@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)['"]/g,
    /(?:import|from)\s+['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g,
    /require\s*\(\s*['"](@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]\s*\)/g,
    /pip\s+install\s+([a-zA-Z][a-zA-Z0-9_-]*)/g,
    /`(@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)`/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      let name = match[1];
      name = name.replace(/@[\d^~>=<.*]+$/, '');
      if (isValidPackageName(name, minLength) && !packages.includes(name)) {
        packages.push(name);
      }
    }
  }

  return packages;
}

export function isValidPackageName(name, minLength = 2) {
  if (!name || name.length < minLength || name.length >= 60) return false;
  if (name.startsWith('./') || name.startsWith('../') || name.startsWith('/')) return false;

  const exclude = new Set([
    'fs', 'path', 'os', 'util', 'http', 'https', 'net', 'url', 'crypto',
    'stream', 'events', 'buffer', 'child_process', 'cluster', 'dgram',
    'dns', 'domain', 'readline', 'repl', 'tls', 'tty', 'v8', 'vm', 'zlib',
    'assert', 'async_hooks', 'console', 'constants', 'perf_hooks', 'process',
    'querystring', 'string_decoder', 'timers', 'worker_threads', 'inspector',
    'module', 'punycode', 'sys', 'wasi',
    'src', 'lib', 'dist', 'build', 'test', 'tests', 'spec', 'utils', 'helpers',
    'components', 'pages', 'hooks', 'services', 'models', 'types', 'interfaces',
  ]);

  return !exclude.has(name);
}

export function extractEntitiesFromEntry(entry, config = {}) {
  const categories = config.categories || { files: true, functions: true, errors: true, packages: true };
  const result = {};

  if (categories.files !== false) {
    const files = extractFilePaths(entry, config);
    if (files.length > 0) result.files = files;
  }

  if (categories.functions !== false) {
    const functions = extractFunctionNames(entry, config);
    if (functions.length > 0) result.functions = functions;
  }

  if (categories.errors !== false) {
    const errors = extractErrorMessages(entry, config);
    if (errors.length > 0) result.errors = errors;
  }

  if (categories.packages !== false) {
    const packages = extractPackageNames(entry, config);
    if (packages.length > 0) result.packages = packages;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Entity index management
// ---------------------------------------------------------------------------

export function emptyEntityIndex() {
  return {
    files: {},
    functions: {},
    errors: {},
    packages: {},
    lastUpdated: null
  };
}

/**
 * Load entity index from a project directory.
 * @param {string} projectDir - Absolute path to project memory dir
 * @param {function} [logErrorFn] - Optional error logger
 */
export function loadEntityIndex(projectDir, logErrorFn) {
  const entitiesPath = join(projectDir, 'entities.json');
  if (existsSync(entitiesPath)) {
    try {
      return JSON.parse(readFileSync(entitiesPath, 'utf-8'));
    } catch (e) {
      if (logErrorFn) logErrorFn(e, 'loadEntityIndex:entities.json');
      return emptyEntityIndex();
    }
  }
  return emptyEntityIndex();
}

export function pruneEntityIndex(index, eeConfig = {}) {
  const maxAgeDays = eeConfig.maxAgeDays ?? 7;
  if (maxAgeDays <= 0) return;

  if (index.lastPruned) {
    const sincePrune = Date.now() - new Date(index.lastPruned).getTime();
    if (sincePrune < 24 * 60 * 60 * 1000) return;
  }

  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

  for (const category of ['files', 'functions', 'errors', 'packages']) {
    if (!index[category]) continue;
    for (const [name, data] of Object.entries(index[category])) {
      if (!data.lastSeen || new Date(data.lastSeen).getTime() < cutoff) {
        delete index[category][name];
      }
    }
  }

  index.lastPruned = new Date().toISOString();
}

export function truncateContext(text, maxLen) {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 3) + '...';
}

/**
 * Update the entity index with extracted entities from a single entry.
 * Writes to projectDir/entities.json.
 *
 * @param {object} entry - Log entry
 * @param {string} projectDir - Absolute path to project memory dir
 * @param {object} [config] - Config with entityExtraction settings
 * @param {object} [options] - { logErrorFn, withFileLockFn }
 */
export function updateEntityIndex(entry, projectDir, config = {}, options = {}) {
  const eeConfig = config.entityExtraction || {};
  if (eeConfig.enabled === false) return;

  const entities = extractEntitiesFromEntry(entry, eeConfig);
  if (Object.keys(entities).length === 0) return;

  const entitiesPath = join(projectDir, 'entities.json');
  const logErrorFn = options.logErrorFn || (() => {});

  // Ensure directory exists
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  const doUpdate = () => {
    const index = loadEntityIndex(projectDir, logErrorFn);
    const maxContexts = eeConfig.maxContextsPerEntity || 5;

    const contextSummary = {
      ts: entry.ts,
      type: entry.type,
      summary: truncateContext(entry.content || entry.subject || '', 80)
    };

    for (const [category, names] of Object.entries(entities)) {
      if (!index[category]) index[category] = {};

      for (const name of names) {
        if (!index[category][name]) {
          index[category][name] = {
            mentions: 0,
            lastSeen: null,
            contexts: []
          };
        }

        const entityData = index[category][name];
        entityData.mentions++;
        entityData.lastSeen = entry.ts;

        entityData.contexts.push(contextSummary);
        if (entityData.contexts.length > maxContexts) {
          entityData.contexts = entityData.contexts.slice(-maxContexts);
        }
      }
    }

    index.lastUpdated = new Date().toISOString();
    pruneEntityIndex(index, eeConfig);

    try {
      writeFileSync(entitiesPath, JSON.stringify(index, null, 2));
    } catch (e) {
      logErrorFn(e, 'updateEntityIndex:write');
    }
  };

  // If a file lock function is provided (client-side), use it.
  // Server-side doesn't need locking — it's the single writer.
  if (options.withFileLockFn) {
    const lockPath = entitiesPath + '.lock';
    options.withFileLockFn(lockPath, doUpdate);
  } else {
    doUpdate();
  }
}

// ---------------------------------------------------------------------------
// Relevance scoring (uses entity data)
// ---------------------------------------------------------------------------

export function calculateRecencyScore(timestamp, halfLifeHours = 24) {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  return Math.pow(0.5, ageHours / halfLifeHours);
}

export function calculateEntityRelevanceScore(entry, entityIndex, config = {}) {
  if (!entityIndex || Object.keys(entityIndex).length === 0) return 0.5;

  const entities = extractEntitiesFromEntry(entry, config);
  if (Object.keys(entities).length === 0) return 0.5;

  let totalScore = 0;
  let entityCount = 0;

  for (const [category, names] of Object.entries(entities)) {
    if (!entityIndex[category]) continue;

    for (const name of names) {
      const entityData = entityIndex[category][name];
      if (!entityData) continue;

      entityCount++;
      const recency = entityData.lastSeen ? calculateRecencyScore(entityData.lastSeen, 24) : 0;
      const frequency = Math.min(entityData.mentions / 10, 1);
      totalScore += 0.6 * recency + 0.4 * frequency;
    }
  }

  return entityCount > 0 ? totalScore / entityCount : 0.5;
}
