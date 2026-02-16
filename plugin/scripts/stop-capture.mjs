#!/usr/bin/env node
/**
 * Stop Hook — Thin forwarder to Plugin Service
 *
 * All response capture logic lives in CaptureService (server-side).
 * This hook just reads stdin and forwards the data. If the server
 * is unreachable, it logs the error and exits cleanly.
 */

import { getClient } from '../client/mneme-client.mjs';
import { logError } from './utils.mjs';
import { execFileSync } from 'node:child_process';

function getProjectRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return cwd;
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  try {
    const hookData = JSON.parse(input);
    const cwd = hookData.cwd || process.cwd();
    const project = getProjectRoot(cwd);
    const client = await getClient();
    await client.captureStop(project, hookData);
  } catch (e) {
    logError(e, 'stop-capture');
  }
  process.exit(0);
});

// Hard timeout — don't block Claude Code
setTimeout(() => process.exit(0), 5000);
