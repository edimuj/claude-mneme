#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = import.meta.dirname;
const FILES = {
  pluginJson: join(ROOT, 'plugin/.claude-plugin/plugin.json'),
  packageJson: join(ROOT, 'plugin/package.json'),
  readme: join(ROOT, 'README.md'),
};

function readVersion() {
  const manifest = JSON.parse(readFileSync(FILES.pluginJson, 'utf8'));
  return manifest.version;
}

function bump(current, type) {
  const [major, minor, patch] = current.split('.').map(Number);
  switch (type) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default:
      if (/^\d+\.\d+\.\d+$/.test(type)) return type;
      console.error(`Usage: node release.mjs <patch|minor|major|X.Y.Z>`);
      process.exit(2);
  }
}

function updateFile(path, oldVersion, newVersion) {
  const content = readFileSync(path, 'utf8');
  const updated = content.replaceAll(oldVersion, newVersion);
  if (content === updated) {
    console.error(`  ⚠ ${path} — no changes (version not found)`);
    return false;
  }
  writeFileSync(path, updated);
  return true;
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node release.mjs <patch|minor|major|X.Y.Z>');
  process.exit(2);
}

const current = readVersion();
const next = bump(current, arg);

if (current === next) {
  console.error(`Already at ${current}`);
  process.exit(0);
}

console.log(`${current} → ${next}\n`);

for (const [name, path] of Object.entries(FILES)) {
  const changed = updateFile(path, current, next);
  const short = path.replace(ROOT + '/', '');
  console.log(`  ${changed ? '✓' : '⚠'} ${short}`);
}

git('add', ...Object.values(FILES).map(p => p.replace(ROOT + '/', '')));
git('commit', '-m', `chore: release ${next}`);
git('push');

console.log(`\nReleased ${next} — committed and pushed.`);
