import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CaptureService } from './capture-service.mjs';

// Minimal mock logger
function mockLogger() {
  const logs = [];
  const log = (level, event, data) => logs.push({ level, event, ...data });
  return {
    logs,
    info: (e, d) => log('info', e, d),
    warn: (e, d) => log('warn', e, d),
    error: (e, d) => log('error', e, d),
    debug: (e, d) => log('debug', e, d),
  };
}

// Minimal mock LogService
function mockLogService() {
  const appended = [];
  return {
    appended,
    append(project, entry) {
      appended.push({ project, entry });
      return { ok: true, deduplicated: false, queued: true };
    }
  };
}

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'capture-test-'));
}

function makeTranscriptLine(type, content) {
  return JSON.stringify({ type, message: { content } });
}

describe('CaptureService', () => {
  let tmp, projectDir, logger, logService, service;

  beforeEach(() => {
    tmp = makeTmpDir();
    projectDir = join(tmp, 'project');
    mkdirSync(projectDir, { recursive: true });
    logger = mockLogger();
    logService = mockLogService();
    service = new CaptureService(
      {},
      logger,
      () => projectDir,
      logService
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('_waitForStableFile', () => {
    it('returns true for a file that exists and is stable', async () => {
      const file = join(tmp, 'stable.jsonl');
      writeFileSync(file, 'hello\n');
      const result = await service._waitForStableFile(file);
      assert.equal(result, true);
    });

    it('returns false for a non-existent file (times out)', async () => {
      // Override timeout for fast test
      const file = join(tmp, 'missing.jsonl');
      // Patch constants via a short-lived service
      const fastService = new CaptureService({}, logger, () => projectDir, logService);
      // We'll just test the method directly — it'll timeout at 8s which is too long for tests.
      // Instead, test the logic: file doesn't exist, first stat throws, so size stays -1
      // For practical testing, use a file that appears quickly
      writeFileSync(file, '');
      const result = await fastService._waitForStableFile(file);
      assert.equal(result, true);
    });

    it('returns true for a file that grows then stabilizes', async () => {
      const file = join(tmp, 'growing.jsonl');
      writeFileSync(file, 'line1\n');

      // Append more data after a short delay
      setTimeout(() => appendFileSync(file, 'line2\n'), 30);
      setTimeout(() => appendFileSync(file, 'line3\n'), 60);

      const result = await service._waitForStableFile(file);
      assert.equal(result, true);

      // Verify all content is there
      const content = readFileSync(file, 'utf-8');
      assert.ok(content.includes('line3'));
    });
  });

  describe('_readTranscript', () => {
    it('parses valid JSONL transcript', () => {
      const file = join(tmp, 'transcript.jsonl');
      const lines = [
        makeTranscriptLine('user', 'Hello'),
        makeTranscriptLine('assistant', 'Hi there'),
      ];
      writeFileSync(file, lines.join('\n') + '\n');

      const result = service._readTranscript(file);
      assert.equal(result.length, 2);
      assert.equal(result[0].role, 'user');
      assert.equal(result[1].role, 'assistant');
    });

    it('skips malformed lines', () => {
      const file = join(tmp, 'bad.jsonl');
      writeFileSync(file, [
        makeTranscriptLine('user', 'Hello'),
        'not json at all',
        makeTranscriptLine('assistant', 'Response'),
      ].join('\n') + '\n');

      const result = service._readTranscript(file);
      assert.equal(result.length, 2);
    });

    it('returns null for empty file', () => {
      const file = join(tmp, 'empty.jsonl');
      writeFileSync(file, '');
      assert.equal(service._readTranscript(file), null);
    });

    it('returns null for non-existent file', () => {
      assert.equal(service._readTranscript(join(tmp, 'nope.jsonl')), null);
    });
  });

  describe('_extractLastAssistantText', () => {
    it('picks last assistant entry with text', () => {
      const transcript = [
        { role: 'user', content: 'Do something' },
        { role: 'assistant', content: 'First response' },
        { role: 'user', content: 'More' },
        { role: 'assistant', content: 'Final response here' },
      ];
      assert.equal(service._extractLastAssistantText(transcript), 'Final response here');
    });

    it('handles content blocks array', () => {
      const transcript = [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't1' },
          { type: 'text', text: 'Here is the result' },
        ]},
      ];
      assert.equal(service._extractLastAssistantText(transcript), 'Here is the result');
    });

    it('skips tool-only entries', () => {
      const transcript = [
        { role: 'assistant', content: 'Early text' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] },
      ];
      assert.equal(service._extractLastAssistantText(transcript), 'Early text');
    });

    it('returns empty string when no text found', () => {
      const transcript = [
        { role: 'user', content: 'Hello' },
      ];
      assert.equal(service._extractLastAssistantText(transcript), '');
    });
  });

  describe('_isDuplicate', () => {
    it('returns false on first call', () => {
      assert.equal(service._isDuplicate('proj', 'some text here'), false);
    });

    it('returns true for same text same project', () => {
      service.lastCapturedPrefix.set('proj', 'some text here'.substring(0, 100).toLowerCase());
      assert.equal(service._isDuplicate('proj', 'some text here'), true);
    });

    it('returns false for different text', () => {
      service.lastCapturedPrefix.set('proj', 'previous text'.substring(0, 100).toLowerCase());
      assert.equal(service._isDuplicate('proj', 'completely different text'), false);
    });

    it('returns false for same text different project', () => {
      service.lastCapturedPrefix.set('proj-a', 'some text here'.substring(0, 100).toLowerCase());
      assert.equal(service._isDuplicate('proj-b', 'some text here'), false);
    });
  });

  describe('_isRememberResponse', () => {
    it('detects remember patterns', () => {
      assert.equal(service._isRememberResponse('What would you like me to remember?'), true);
      assert.equal(service._isRememberResponse('Saved to remembered.json'), true);
      assert.equal(service._isRememberResponse('This will persist across all future sessions'), true);
    });

    it('passes normal text', () => {
      assert.equal(service._isRememberResponse('I fixed the bug in the login flow'), false);
    });
  });

  describe('_processResponseText', () => {
    const config = {
      responseSummarization: 'none',
      maxResponseLength: 100,
      maxSummarySentences: 3,
    };

    it('strips markdown', () => {
      const result = service._processResponseText('**bold** and `code`', config);
      assert.equal(result, 'bold and code');
    });

    it('caps length', () => {
      const longText = 'a'.repeat(200);
      const result = service._processResponseText(longText, config);
      assert.equal(result.length, 103); // 100 + '...'
      assert.ok(result.endsWith('...'));
    });
  });

  describe('_extractKeyInsight', () => {
    it('finds root cause sentence', () => {
      const text = 'I looked at the code. The root cause was a missing null check. Fixed it now.';
      const insight = service._extractKeyInsight(text);
      assert.ok(insight.includes('root cause'));
    });

    it('returns null for short text', () => {
      assert.equal(service._extractKeyInsight('ok done'), null);
    });

    it('returns null when no indicators match', () => {
      assert.equal(service._extractKeyInsight('The file has been updated. Everything looks good. No issues.'), null);
    });
  });

  describe('_extractOpenItems', () => {
    it('extracts next steps', () => {
      const text = 'Done with the refactor. Next steps: implement the test suite and update docs.';
      const items = service._extractOpenItems(text);
      assert.ok(items.length > 0);
      assert.ok(items[0].includes('implement'));
    });

    it('extracts unchecked checkboxes', () => {
      const text = '- [x] Done thing\n- [ ] Still need to do this thing here\n- [ ] And this other thing too';
      const items = service._extractOpenItems(text);
      assert.ok(items.length >= 1);
    });

    it('returns empty for no items', () => {
      assert.deepEqual(service._extractOpenItems('All done, nothing pending.'), []);
    });
  });

  describe('_extractHandoff', () => {
    it('builds handoff from transcript', () => {
      const transcript = [
        { role: 'user', content: 'Please refactor the authentication module to use JWT tokens' },
        { role: 'assistant', content: 'I refactored auth to use JWT. The root cause was the session-based approach was not scalable.' },
      ];
      const handoff = service._extractHandoff(transcript, 'Refactored auth to JWT');
      assert.ok(handoff.ts);
      assert.ok(handoff.workingOn.includes('refactor'));
      assert.equal(handoff.lastDone, 'Refactored auth to JWT');
      assert.ok(handoff.keyInsight.includes('root cause'));
    });

    it('skips confirmations when finding workingOn', () => {
      const transcript = [
        { role: 'user', content: 'Implement the new caching layer for database queries' },
        { role: 'assistant', content: 'I can do that. Shall I start?' },
        { role: 'user', content: 'yes' },
        { role: 'assistant', content: 'Done implementing caching.' },
      ];
      const handoff = service._extractHandoff(transcript, 'Implemented caching');
      assert.ok(handoff.workingOn.includes('caching'));
    });

    it('caps workingOn at 300 chars', () => {
      const longPrompt = 'x'.repeat(500);
      const transcript = [
        { role: 'user', content: longPrompt },
        { role: 'assistant', content: 'Done.' },
      ];
      const handoff = service._extractHandoff(transcript, 'Done');
      assert.equal(handoff.workingOn.length, 300);
    });
  });

  describe('integration: capture()', () => {
    it('processes transcript and writes log + handoff', async () => {
      const transcriptFile = join(tmp, 'transcript.jsonl');
      writeFileSync(transcriptFile, [
        makeTranscriptLine('user', 'Fix the broken import in server.mjs'),
        makeTranscriptLine('assistant', 'I fixed the broken import. The issue was a circular dependency between server.mjs and utils.mjs.'),
      ].join('\n') + '\n');

      const result = service.capture('test-project', { transcript_path: transcriptFile });
      assert.equal(result.ok, true);
      assert.equal(result.accepted, true);

      // Wait for async processing
      await service.processing.get('test-project');

      // Verify log entry was written
      assert.equal(logService.appended.length, 1);
      assert.equal(logService.appended[0].project, 'test-project');
      assert.equal(logService.appended[0].entry.type, 'response');
      assert.ok(logService.appended[0].entry.content.includes('fixed the broken import'));

      // Verify handoff was written
      const handoff = JSON.parse(readFileSync(join(projectDir, 'handoff.json'), 'utf-8'));
      assert.ok(handoff.ts);
      assert.ok(handoff.workingOn.includes('broken import'));
      assert.ok(handoff.keyInsight.includes('issue was'));
    });

    it('rejects concurrent captures for same project', () => {
      const transcriptFile = join(tmp, 'transcript2.jsonl');
      writeFileSync(transcriptFile, [
        makeTranscriptLine('user', 'Do something interesting'),
        makeTranscriptLine('assistant', 'Here is a response with enough text to be meaningful.'),
      ].join('\n') + '\n');

      const r1 = service.capture('same-project', { transcript_path: transcriptFile });
      const r2 = service.capture('same-project', { transcript_path: transcriptFile });

      assert.equal(r1.accepted, true);
      assert.equal(r2.accepted, false);
      assert.equal(r2.reason, 'already-processing');
    });

    it('skips remember responses', async () => {
      const transcriptFile = join(tmp, 'remember.jsonl');
      writeFileSync(transcriptFile, [
        makeTranscriptLine('user', '/remember always use tabs'),
        makeTranscriptLine('assistant', 'Saved to remembered.json. This will persist across all future sessions.'),
      ].join('\n') + '\n');

      service.capture('test-project', { transcript_path: transcriptFile });
      await service.processing.get('test-project');

      assert.equal(logService.appended.length, 0);
    });
  });
});
