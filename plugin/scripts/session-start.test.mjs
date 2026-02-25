import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SESSION_START = fileURLToPath(new URL('./session-start.mjs', import.meta.url));

/**
 * Helper: set up a fake project directory with memory data.
 * Creates a git repo so gatherContextSignals has something to read.
 */
function setupProject(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mneme-integ-'));
  const projectDir = join(root, 'project');
  mkdirSync(projectDir);

  // Init git repo
  execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectDir, stdio: 'ignore' });
  writeFileSync(join(projectDir, 'README.md'), '# Test\n');
  execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });

  if (opts.branch) {
    execFileSync('git', ['checkout', '-b', opts.branch], { cwd: projectDir, stdio: 'ignore' });
  }

  if (opts.modifiedFile) {
    writeFileSync(join(projectDir, opts.modifiedFile), 'modified\n');
  }

  // Set up mneme data directory — must match getProjectMemoryDir() convention
  // /tmp/foo/project → -tmp-foo-project (leading / becomes -, rest of / becomes -)
  const absPath = projectDir.replace(/^\//, '-').replace(/\//g, '-');
  const dataDir = join(root, '.claude-mneme', 'projects', absPath);
  mkdirSync(dataDir, { recursive: true });

  // Config pointing to our custom data root
  const configDir = join(root, '.claude-mneme');
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(opts.config || {}, null, 2));

  // Summary
  if (opts.summary) {
    writeFileSync(join(dataDir, 'summary.json'), JSON.stringify(opts.summary, null, 2));
  }

  // Log entries
  if (opts.logEntries) {
    const jsonl = opts.logEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(dataDir, 'log.jsonl'), jsonl);
  }

  // Remembered items
  if (opts.remembered) {
    writeFileSync(join(dataDir, 'remembered.json'), JSON.stringify(opts.remembered, null, 2));
  }

  // Entities
  if (opts.entities) {
    writeFileSync(join(dataDir, 'entities.json'), JSON.stringify(opts.entities, null, 2));
  }

  // Handoff
  if (opts.handoff) {
    writeFileSync(join(dataDir, 'handoff.json'), JSON.stringify(opts.handoff, null, 2));
  }

  // Last session timestamp
  if (opts.lastSession) {
    writeFileSync(join(dataDir, '.last-session'), opts.lastSession);
  }

  return { root, projectDir, dataDir, configPath };
}

/**
 * Run session-start.mjs against a project directory.
 * Override HOME so it finds our test .claude-mneme directory.
 */
function runSessionStart(projectDir, homeDir) {
  try {
    const output = execFileSync('node', [SESSION_START], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output;
  } catch (err) {
    // session-start exits 0 even on errors, but capture stderr too
    return err.stdout || '';
  }
}

// ============================================================================
// Integration: Retrieval-active path
// ============================================================================
describe('session-start integration: retrieval active', () => {
  let env;

  before(() => {
    const now = new Date();
    env = setupProject({
      branch: 'feature/auth-redesign',
      modifiedFile: 'auth.mjs',
      summary: {
        lastUpdated: now.toISOString(),
        projectContext: 'A web application with user authentication',
        keyDecisions: [
          { decision: 'Use JWT for auth tokens', reason: 'Stateless session management', foundational: true },
          { decision: 'Use PostgreSQL for data', reason: 'Relational data model', foundational: true },
          { decision: 'Dashboard uses vanilla HTML', reason: 'No build step needed', foundational: false },
          { decision: 'Rate limit auth endpoints', reason: 'Prevent brute force', foundational: false },
        ],
        currentState: [
          { topic: 'Auth system', status: 'Redesigning token refresh flow' },
          { topic: 'Dashboard', status: 'Stable, no changes planned' },
          { topic: 'Database migration', status: 'Completed and deployed' },
        ],
        recentWork: [
          { date: now.toISOString().slice(0, 10), summary: 'Refactored auth token validation' },
          { date: now.toISOString().slice(0, 10), summary: 'Updated dashboard styles' },
        ],
      },
      logEntries: [
        { ts: new Date(now - 1800000).toISOString(), type: 'commit', content: 'fix: auth token refresh race condition' },
        { ts: new Date(now - 3600000).toISOString(), type: 'prompt', content: 'update the dashboard color scheme' },
        { ts: new Date(now - 900000).toISOString(), type: 'response', content: 'Fixed the auth token validation to handle expired tokens' },
      ],
      remembered: [
        { type: 'note', content: 'Auth tokens expire after 24h' },
        { type: 'lesson', content: 'Always validate refresh tokens server-side' },
      ],
      entities: {
        files: {
          'auth.mjs': { mentions: 8, lastSeen: now.toISOString() },
          'dashboard.html': { mentions: 3, lastSeen: new Date(now - 86400000).toISOString() },
        },
        functions: {
          'validateToken': { mentions: 5, lastSeen: now.toISOString() },
        },
      },
      handoff: {
        ts: now.toISOString(),
        workingOn: 'Auth token refresh redesign',
        lastDone: 'Fixed race condition in token validation',
        keyInsight: 'Need to handle concurrent refresh requests',
      },
      lastSession: new Date(now - 3600000).toISOString(),
    });
  });

  after(() => {
    rmSync(env.root, { recursive: true, force: true });
  });

  it('produces output with claude-mneme tags', () => {
    const output = runSessionStart(env.projectDir, env.root);
    assert.ok(output.includes('<claude-mneme project='), 'should have opening tag');
    assert.ok(output.includes('</claude-mneme>'), 'should have closing tag');
  });

  it('includes signal strength indicator', () => {
    const output = runSessionStart(env.projectDir, env.root);
    assert.ok(output.includes('Context:'), `should show signal strength, got: ${output.slice(0, 500)}`);
    assert.ok(/Context: \d+% signal/.test(output), 'should show percentage');
  });

  it('includes handoff from previous session', () => {
    const output = runSessionStart(env.projectDir, env.root);
    assert.ok(output.includes('Auth token refresh redesign'), 'should include workingOn');
    assert.ok(output.includes('race condition'), 'should include lastDone');
  });

  it('includes auth-related decisions over unrelated ones', () => {
    const output = runSessionStart(env.projectDir, env.root);
    // Auth decisions should appear (foundational or relevant)
    assert.ok(output.includes('JWT for auth'), 'should include foundational auth decision');
    // Unrelated decisions should be filtered out
    assert.ok(!output.includes('Dashboard uses vanilla'), 'should filter out unrelated dashboard decision');
  });

  it('includes relevant current state', () => {
    const output = runSessionStart(env.projectDir, env.root);
    assert.ok(output.includes('Auth system'), 'should include auth state');
  });

  it('includes lessons in Lessons Learned section', () => {
    const output = runSessionStart(env.projectDir, env.root);
    assert.ok(output.includes('Lessons Learned'), 'should have lessons section');
    assert.ok(output.includes('validate refresh tokens'), 'should include the lesson');
  });

  it('includes auth-related log entries over unrelated ones', () => {
    const output = runSessionStart(env.projectDir, env.root);
    assert.ok(output.includes('auth token refresh'), 'should include auth commit');
    assert.ok(output.includes('auth token validation'), 'should include auth response');
  });
});

// ============================================================================
// Integration: Fallback path (weak signals)
// ============================================================================
describe('session-start integration: fallback path', () => {
  let env;

  before(() => {
    const now = new Date();
    env = setupProject({
      // main branch, no modified files → weak signals → retrieval returns null
      summary: {
        lastUpdated: now.toISOString(),
        projectContext: 'A test project',
        keyDecisions: [
          { decision: 'Decision one', reason: 'Reason one', foundational: true },
          { decision: 'Decision two', reason: 'Reason two', foundational: false },
        ],
        currentState: [
          { topic: 'Feature A', status: 'In progress' },
        ],
        recentWork: [
          { date: now.toISOString().slice(0, 10), summary: 'Did some work' },
        ],
      },
      logEntries: [
        { ts: now.toISOString(), type: 'commit', content: 'chore: cleanup' },
      ],
      remembered: [
        { type: 'note', content: 'Remember this thing' },
      ],
    });
  });

  after(() => {
    rmSync(env.root, { recursive: true, force: true });
  });

  it('produces output without signal strength (fallback mode)', () => {
    const output = runSessionStart(env.projectDir, env.root);
    assert.ok(output.includes('<claude-mneme project='), 'should have opening tag');
    // Fallback: no signal indicator since retrieval returned null
    assert.ok(!output.includes('Context:'), 'should NOT show signal strength in fallback');
  });

  it('includes all decisions in fallback mode (no filtering)', () => {
    const output = runSessionStart(env.projectDir, env.root);
    assert.ok(output.includes('Decision one'), 'should include first decision');
    assert.ok(output.includes('Decision two'), 'should include second decision');
  });

  it('includes remembered items', () => {
    const output = runSessionStart(env.projectDir, env.root);
    assert.ok(output.includes('Remember this thing'));
  });
});

// ============================================================================
// Integration: Retrieval disabled via config
// ============================================================================
describe('session-start integration: retrieval disabled', () => {
  let env;

  before(() => {
    const now = new Date();
    env = setupProject({
      branch: 'feature/something',
      modifiedFile: 'something.mjs',
      config: { memoryRetrieval: { enabled: false } },
      summary: {
        lastUpdated: now.toISOString(),
        projectContext: 'Test project with retrieval off',
        keyDecisions: [
          { decision: 'All decisions shown', reason: 'No filtering', foundational: false },
        ],
        currentState: [],
        recentWork: [],
      },
      handoff: {
        ts: now.toISOString(),
        workingOn: 'Something with good signals',
      },
    });
  });

  after(() => {
    rmSync(env.root, { recursive: true, force: true });
  });

  it('uses fallback path when retrieval is disabled', () => {
    const output = runSessionStart(env.projectDir, env.root);
    assert.ok(output.includes('All decisions shown'), 'should include all decisions');
    assert.ok(!output.includes('Context:'), 'should NOT show signal strength');
  });
});

// ============================================================================
// Integration: Empty project (no data)
// ============================================================================
describe('session-start integration: empty project', () => {
  let env;

  before(() => {
    env = setupProject({});
  });

  after(() => {
    rmSync(env.root, { recursive: true, force: true });
  });

  it('produces minimal output (temporal header + tip only)', () => {
    const output = runSessionStart(env.projectDir, env.root);
    // Empty project still shows mneme is active (getRelevantEntities returns non-null)
    assert.ok(output.includes('Session started:'), 'should have temporal header');
    assert.ok(output.includes('/remember'), 'should have tip');
    // But no memory sections
    assert.ok(!output.includes('## Key Decisions'), 'should not have decisions');
    assert.ok(!output.includes('## Current State'), 'should not have state');
    assert.ok(!output.includes('## Recent Activity'), 'should not have entries');
    assert.ok(!output.includes('## Last Session'), 'should not have handoff');
  });
});
