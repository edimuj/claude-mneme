import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./cleanup-stale-versions.mjs', import.meta.url));

function setup({ versions = ['3.15.0', '3.17.10'], current = '3.17.10', manifestEntries, markerVersion } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mneme-cleanup-'));

  // plugins/cache/claude-mneme/claude-mneme/<version>/
  const versionsDir = join(root, 'plugins', 'cache', 'claude-mneme', 'claude-mneme');
  for (const v of versions) {
    const vDir = join(versionsDir, v);
    mkdirSync(vDir, { recursive: true });
    writeFileSync(join(vDir, 'package.json'), JSON.stringify({ name: 'claude-mneme', version: v }));
    mkdirSync(join(vDir, 'scripts'), { recursive: true });
    writeFileSync(join(vDir, 'scripts', 'session-start.mjs'), '// stub');
  }

  const pluginRoot = join(versionsDir, current);
  const pluginData = join(root, 'plugin-data');
  mkdirSync(pluginData, { recursive: true });

  if (markerVersion) {
    writeFileSync(join(pluginData, '.cleanup-version'), markerVersion + '\n');
  }

  // installed_plugins.json
  const manifestPath = join(root, 'plugins', 'installed_plugins.json');
  const entries = manifestEntries || versions.map(v => ({
    scope: 'user',
    installPath: join(versionsDir, v),
    version: v,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastUpdated: '2026-01-01T00:00:00.000Z',
  }));
  writeFileSync(manifestPath, JSON.stringify({
    version: 2,
    plugins: { 'claude-mneme@claude-mneme': entries }
  }, null, 2) + '\n');

  return { root, pluginRoot, pluginData, versionsDir, manifestPath };
}

describe('cleanup-stale-versions', () => {
  const roots = [];
  afterEach(() => {
    for (const r of roots) {
      try { rmSync(r, { recursive: true, force: true }); } catch {}
    }
    roots.length = 0;
  });

  function run(env) {
    return execFileSync('node', [SCRIPT], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  it('removes old version directories', () => {
    const { root, pluginRoot, pluginData, versionsDir } = setup({
      versions: ['3.13.0', '3.15.0', '3.17.10'],
      current: '3.17.10',
    });
    roots.push(root);

    run({ CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: pluginData });

    const remaining = readdirSync(versionsDir);
    assert.deepStrictEqual(remaining, ['3.17.10']);
  });

  it('cleans stale manifest entries', () => {
    const { root, pluginRoot, pluginData, versionsDir, manifestPath } = setup({
      versions: ['3.13.0', '3.17.10'],
      current: '3.17.10',
    });
    roots.push(root);

    run({ CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: pluginData });

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entries = manifest.plugins['claude-mneme@claude-mneme'];
    assert.equal(entries.length, 1);
    assert.equal(entries[0].installPath, pluginRoot);
    assert.equal(entries[0].version, '3.17.10');
  });

  it('writes version marker after cleanup', () => {
    const { root, pluginRoot, pluginData } = setup({ versions: ['3.17.10'], current: '3.17.10' });
    roots.push(root);

    run({ CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: pluginData });

    const marker = readFileSync(join(pluginData, '.cleanup-version'), 'utf8').trim();
    assert.equal(marker, '3.17.10');
  });

  it('skips if marker matches current version', () => {
    const { root, pluginRoot, pluginData, versionsDir } = setup({
      versions: ['3.13.0', '3.17.10'],
      current: '3.17.10',
      markerVersion: '3.17.10',
    });
    roots.push(root);

    run({ CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: pluginData });

    // Old version should still be there — cleanup was skipped
    assert.ok(existsSync(join(versionsDir, '3.13.0')));
  });

  it('runs cleanup when marker has old version', () => {
    const { root, pluginRoot, pluginData, versionsDir } = setup({
      versions: ['3.15.0', '3.17.10'],
      current: '3.17.10',
      markerVersion: '3.15.0',
    });
    roots.push(root);

    run({ CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: pluginData });

    assert.ok(!existsSync(join(versionsDir, '3.15.0')));
    const marker = readFileSync(join(pluginData, '.cleanup-version'), 'utf8').trim();
    assert.equal(marker, '3.17.10');
  });

  it('preserves manifest entry when already clean', () => {
    const { root, pluginRoot, pluginData, manifestPath } = setup({
      versions: ['3.17.10'],
      current: '3.17.10',
      manifestEntries: [{
        scope: 'user',
        installPath: undefined, // will be set below
        version: '3.17.10',
        installedAt: '2026-01-01T00:00:00.000Z',
        lastUpdated: '2026-05-29T00:00:00.000Z',
      }],
    });
    roots.push(root);

    // Fix installPath to actual path
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.plugins['claude-mneme@claude-mneme'][0].installPath = pluginRoot;
    const original = JSON.stringify(manifest, null, 2) + '\n';
    writeFileSync(manifestPath, original);

    run({ CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: pluginData });

    // Manifest should be unchanged
    assert.equal(readFileSync(manifestPath, 'utf8'), original);
  });

  it('fixes manifest when single entry has wrong installPath', () => {
    const { root, pluginRoot, pluginData, versionsDir, manifestPath } = setup({
      versions: ['3.17.10'],
      current: '3.17.10',
    });
    roots.push(root);

    // Overwrite manifest with a stale entry pointing to old version
    const staleManifest = {
      version: 2,
      plugins: { 'claude-mneme@claude-mneme': [{
        scope: 'user',
        installPath: join(versionsDir, '3.13.0'),
        version: '3.13.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      }] }
    };
    writeFileSync(manifestPath, JSON.stringify(staleManifest, null, 2) + '\n');

    run({ CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: pluginData });

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entries = manifest.plugins['claude-mneme@claude-mneme'];
    assert.equal(entries.length, 1);
    assert.equal(entries[0].installPath, pluginRoot);
    assert.equal(entries[0].version, '3.17.10');
  });

  it('exits silently without env vars', () => {
    // Should not throw
    run({ CLAUDE_PLUGIN_ROOT: '', CLAUDE_PLUGIN_DATA: '' });
  });

  it('does not touch other plugins in manifest', () => {
    const { root, pluginRoot, pluginData, manifestPath } = setup({
      versions: ['3.13.0', '3.17.10'],
      current: '3.17.10',
    });
    roots.push(root);

    // Add another plugin to manifest
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.plugins['other-plugin@marketplace'] = [{
      scope: 'user',
      installPath: '/some/other/path',
      version: '1.0.0',
    }];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    run({ CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: pluginData });

    const updated = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(updated.plugins['other-plugin@marketplace'].length, 1);
    assert.equal(updated.plugins['other-plugin@marketplace'][0].version, '1.0.0');
  });
});
