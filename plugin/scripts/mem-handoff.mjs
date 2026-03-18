#!/usr/bin/env node
/**
 * Save a session briefing for the next session.
 * Reads structured JSON from stdin, writes to briefing.json.
 * Next session-start will inject it and archive it automatically.
 */

import { writeFileSync } from 'node:fs';
import { ensureMemoryDirs, getProjectName, invalidateCache, logError } from './utils.mjs';

const cwd = process.cwd();
const paths = ensureMemoryDirs(cwd);
const projectName = getProjectName(cwd);
const briefingPath = paths.briefing;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    if (!data.summary) {
      console.error('Error: "summary" field is required');
      process.exit(1);
    }

    const briefing = {
      ts: new Date().toISOString(),
      summary: data.summary,
      ...(data.keyDecisions?.length > 0 && { keyDecisions: data.keyDecisions }),
      ...(data.currentState && { currentState: data.currentState }),
      ...(data.nextSteps?.length > 0 && { nextSteps: data.nextSteps }),
      ...(data.blockers?.length > 0 && { blockers: data.blockers }),
      ...(data.context && { context: data.context }),
    };

    writeFileSync(briefingPath, JSON.stringify(briefing, null, 2) + '\n');
    invalidateCache(cwd);

    console.log(`Briefing saved for "${projectName}". Next session will pick it up automatically.`);

  } catch (e) {
    logError(e, 'mem-handoff');
    console.error(`Error saving briefing: ${e.message}`);
    process.exit(1);
  }
});
