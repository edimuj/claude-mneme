#!/usr/bin/env node

import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const MEMORY_BASE = join(homedir(), '.claude-mneme');
const PID_FILE = join(MEMORY_BASE, '.dashboard.pid');
const SERVER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');

function readPid() {
  try {
    if (!existsSync(PID_FILE)) return null;
    return JSON.parse(readFileSync(PID_FILE, 'utf-8'));
  } catch { return null; }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function cleanStalePid() {
  const info = readPid();
  if (info && !isAlive(info.pid)) {
    try { unlinkSync(PID_FILE); } catch { /* ok */ }
    return true;
  }
  return false;
}

const command = process.argv[2];

if (command === 'start') {
  cleanStalePid();
  const info = readPid();
  if (info && isAlive(info.pid)) {
    const url = info.host === '0.0.0.0'
      ? `http://localhost:${info.port}`
      : `http://${info.host}:${info.port}`;
    console.log(`Dashboard already running (PID ${info.pid}): ${url}`);
    process.exit(0);
  }

  // Forward --port / --host from CLI if provided
  const extraArgs = [];
  const portIdx = process.argv.indexOf('--port');
  if (portIdx >= 0 && process.argv[portIdx + 1]) {
    extraArgs.push('--port', process.argv[portIdx + 1]);
  }
  const hostIdx = process.argv.indexOf('--host');
  if (hostIdx >= 0 && process.argv[hostIdx + 1]) {
    extraArgs.push('--host', process.argv[hostIdx + 1]);
  }

  execFile(process.execPath, [SERVER_SCRIPT, '--daemon', ...extraArgs], (err, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (err) process.exit(1);
  });

} else if (command === 'stop') {
  const info = readPid();
  if (!info) {
    console.log('Dashboard is not running');
    process.exit(0);
  }
  if (!isAlive(info.pid)) {
    try { unlinkSync(PID_FILE); } catch { /* ok */ }
    console.log('Dashboard was not running (cleaned stale PID file)');
    process.exit(0);
  }
  try {
    process.kill(info.pid, 'SIGTERM');
    console.log(`Dashboard stopped (PID ${info.pid})`);
  } catch (e) {
    console.error(`Failed to stop dashboard: ${e.message}`);
    process.exit(1);
  }
  // PID file is cleaned by the server's shutdown handler, but clean up just in case
  setTimeout(() => {
    try { unlinkSync(PID_FILE); } catch { /* ok */ }
  }, 500);

} else if (command === 'status') {
  cleanStalePid();
  const info = readPid();
  if (!info) {
    console.log('Dashboard: stopped');
    process.exit(0);
  }
  if (!isAlive(info.pid)) {
    console.log('Dashboard: stopped (stale PID file cleaned)');
    process.exit(0);
  }
  const url = info.host === '0.0.0.0'
    ? `http://localhost:${info.port}`
    : `http://${info.host}:${info.port}`;
  const uptime = info.startedAt
    ? ` (up since ${new Date(info.startedAt).toLocaleString()})`
    : '';
  console.log(`Dashboard: running (PID ${info.pid}) at ${url}${uptime}`);

} else {
  console.error('Usage: dashboard-ctl.mjs <start|stop|status> [--port N] [--host H]');
  process.exit(2);
}
