#!/usr/bin/env node
// Runs once per version at SessionStart. Removes old cached version directories
// and stale manifest entries that cause "Plugin directory does not exist" errors
// when Claude Code fires hooks registered from a previous plugin version.

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
const pluginData = process.env.CLAUDE_PLUGIN_DATA;

if (!pluginRoot || !pluginData) process.exit(0);

let currentVersion;
try {
  currentVersion = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version;
} catch { process.exit(0); }

if (!currentVersion) process.exit(0);

mkdirSync(pluginData, { recursive: true });
const markerPath = join(pluginData, '.cleanup-version');
try {
  if (readFileSync(markerPath, 'utf8').trim() === currentVersion) process.exit(0);
} catch {}

const versionsDir = dirname(pluginRoot);
const currentDirName = basename(pluginRoot);
const cleaned = [];

// Remove old version directories from cache
try {
  for (const entry of readdirSync(versionsDir)) {
    if (entry === currentDirName) continue;
    const p = join(versionsDir, entry);
    try {
      if (statSync(p).isDirectory()) {
        rmSync(p, { recursive: true, force: true });
        cleaned.push(entry);
      }
    } catch {}
  }
} catch {}

// Ensure manifest has exactly one entry pointing to current install
const manifestPath = join(versionsDir, '..', '..', '..', 'installed_plugins.json');
try {
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const key = 'claude-mneme@claude-mneme';
    const entries = manifest.plugins?.[key];
    if (Array.isArray(entries)) {
      const needsCleanup = entries.length !== 1 || entries[0].installPath !== pluginRoot;
      if (needsCleanup) {
        const ours = entries.find(e => e.installPath === pluginRoot)
          || { ...entries[entries.length - 1], installPath: pluginRoot, version: currentVersion };
        manifest.plugins[key] = [ours];
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
        cleaned.push('manifest');
      }
    }
  }
} catch {}

writeFileSync(markerPath, currentVersion + '\n');

if (cleaned.length > 0) {
  console.error(`[claude-mneme] Cleaned stale versions: ${cleaned.join(', ')}`);
}
