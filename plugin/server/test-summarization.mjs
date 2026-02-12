#!/usr/bin/env node
/**
 * Quick test for summarization service (throttling, caching)
 */

import { getClient } from '../client/mneme-client.mjs';

async function test() {
  console.log('Testing summarization service...\n');

  const client = await getClient();
  const project = '/tmp/test-summarize-project';

  // Test 1: Trigger summarization
  console.log('1. Triggering summarization (should be not-needed or queued)...');
  const trigger1 = await client.triggerSummarize(project);
  console.log('  Result:', JSON.stringify(trigger1, null, 2));

  // Test 2: Trigger again immediately (should be throttled or already-running)
  console.log('\n2. Triggering again immediately (should be throttled or running)...');
  const trigger2 = await client.triggerSummarize(project);
  console.log('  Result:', JSON.stringify(trigger2, null, 2));

  // Test 3: Get status
  console.log('\n3. Getting summarization status...');
  const status = await client.getSummarizeStatus(project);
  console.log('  Status:', JSON.stringify(status, null, 2));

  // Test 4: Get summary (will be null if no summary exists)
  console.log('\n4. Getting summary (may be null)...');
  const summary = await client.getSummary(project);
  console.log('  Summary exists:', summary.summary !== null);
  console.log('  Cached:', summary.cached);

  // Test 5: Health check (should show cache stats)
  console.log('\n5. Health check (cache stats)...');
  const health = await client.health();
  console.log('  Cache size:', health.cache.size);
  console.log('  Cache hit rate:', health.cache.hitRate.toFixed(2));
  console.log('  Summarizations started:', health.stats.summarization.started);
  console.log('  Summarizations completed:', health.stats.summarization.completed);
  console.log('  Throttled:', health.stats.summarization.throttled);

  console.log('\n✓ All tests completed (check results above)');
  process.exit(0);
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
