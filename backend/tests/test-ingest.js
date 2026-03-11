#!/usr/bin/env node
/**
 * Test CEP Ingestion Endpoints
 *
 * Tests the /api/ingest and /api/ingest/batch endpoints
 *
 * Usage: node test-ingest.js
 */

const API_BASE = 'http://localhost:3000/api';

// Test events
const singleEvent = {
  ts: '2026-03-05T13:00:00.000Z',
  event: 'session.start',
  runner: 'test-runner',
  sessionId: 'test_session_123',
  parentSessionId: null,
  data: {
    title: 'Test session',
    directory: '/test/dir'
  }
};

const batchEvents = [
  {
    ts: '2026-03-05T13:00:01.000Z',
    event: 'tool.start',
    runner: 'test-runner',
    sessionId: 'test_session_123',
    traceId: 'test_trace_1',
    data: {
      tool: 'read',
      args: { filePath: '/test/file.txt' }
    }
  },
  {
    ts: '2026-03-05T13:00:01.042Z',
    event: 'tool.end',
    runner: 'test-runner',
    sessionId: 'test_session_123',
    traceId: 'test_trace_1',
    data: {
      tool: 'read',
      args: { filePath: '/test/file.txt' },
      durationMs: 42,
      status: 'success',
      outputLen: 100
    }
  },
  {
    ts: '2026-03-05T13:00:05.000Z',
    event: 'session.end',
    runner: 'test-runner',
    sessionId: 'test_session_123',
    data: {
      reason: 'completed'
    }
  }
];

async function testSingleIngest() {
  console.log('\n=== Test: Single Event Ingest ===\n');

  try {
    const response = await fetch(`${API_BASE}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(singleEvent)
    });

    const result = await response.json();

    if (response.ok) {
      console.log('✓ Single event ingested successfully');
      console.log('  Key:', result.key);
      console.log('  Event:', result.event);
    } else {
      console.error('✗ Single event ingest failed');
      console.error('  Error:', result.error);
      if (result.details) {
        console.error('  Details:', result.details);
      }
    }
  } catch (error) {
    console.error('✗ Request failed:', error.message);
  }
}

async function testBatchIngest() {
  console.log('\n=== Test: Batch Event Ingest ===\n');

  try {
    const response = await fetch(`${API_BASE}/ingest/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batchEvents)
    });

    const result = await response.json();

    if (response.ok) {
      console.log('✓ Batch events ingested successfully');
      console.log('  Count:', result.count);
      console.log('  Total:', result.total);
    } else {
      console.error('✗ Batch ingest failed');
      console.error('  Error:', result.error);
      if (result.invalidEvents) {
        console.error('  Invalid events:', result.invalidEvents);
      }
    }
  } catch (error) {
    console.error('✗ Request failed:', error.message);
  }
}

async function testInvalidEvent() {
  console.log('\n=== Test: Invalid Event (should fail) ===\n');

  const invalidEvent = {
    // Missing required fields
    event: 'tool.start',
    data: {}
  };

  try {
    const response = await fetch(`${API_BASE}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidEvent)
    });

    const result = await response.json();

    if (!response.ok) {
      console.log('✓ Invalid event rejected as expected');
      console.log('  Error:', result.error);
      console.log('  Details:', result.details);
    } else {
      console.error('✗ Invalid event was accepted (should have been rejected)');
    }
  } catch (error) {
    console.error('✗ Request failed:', error.message);
  }
}

async function verifyData() {
  console.log('\n=== Test: Verify Ingested Data ===\n');

  try {
    const response = await fetch(`${API_BASE}/stats`);
    const result = await response.json();

    console.log('✓ Stats retrieved');
    console.log('  Total entries:', result.total);
    console.log('  Avg duration:', result.avgDur, 'ms');
  } catch (error) {
    console.error('✗ Request failed:', error.message);
  }
}

async function runTests() {
  console.log('Testing CEP Ingestion Endpoints');
  console.log('API Base:', API_BASE);

  await testSingleIngest();
  await testBatchIngest();
  await testInvalidEvent();
  await verifyData();

  console.log('\n=== Tests Complete ===\n');
}

runTests();
