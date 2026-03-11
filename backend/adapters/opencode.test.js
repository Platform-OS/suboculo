/**
 * OpenCode Adapter Tests
 *
 * Run with: node adapters/opencode.test.js
 */

const OpenCodeAdapter = require('./opencode.js');

function assert(condition, message) {
  if (!condition) {
    console.error('❌ FAIL:', message);
    process.exit(1);
  }
  console.log('✓', message);
}

function assertDeepEqual(actual, expected, message) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    console.error('❌ FAIL:', message);
    console.error('  Expected:', expectedStr);
    console.error('  Actual:  ', actualStr);
    process.exit(1);
  }
  console.log('✓', message);
}

// Test data
const testEvents = {
  init: {
    ts: '2026-03-05T12:00:00.000Z',
    kind: 'init',
    directory: '/home/user/project',
    debug: false
  },
  sessionCreated: {
    ts: '2026-03-05T12:00:01.000Z',
    kind: 'session.event',
    type: 'session.created',
    sessionID: 'ses_abc123',
    title: 'Build a feature'
  },
  sessionUpdated: {
    ts: '2026-03-05T12:00:02.000Z',
    kind: 'session.event',
    type: 'session.updated',
    sessionID: 'ses_abc123',
    title: 'Build a feature - updated'
  },
  toolBefore: {
    ts: '2026-03-05T12:00:03.000Z',
    kind: 'tool.before',
    sessionID: 'ses_abc123',
    rootSessionID: 'ses_abc123',
    callID: 'call_read_1',
    tool: 'read',
    subagentType: null
  },
  toolAfter: {
    ts: '2026-03-05T12:00:03.042Z',
    kind: 'tool.after',
    sessionID: 'ses_abc123',
    rootSessionID: 'ses_abc123',
    callID: 'call_read_1',
    tool: 'read',
    durationMs: 42,
    args: { filePath: '/home/user/project/main.py' },
    outputLen: 1024,
    outputPreview: 'import sys...',
    subagentType: null
  },
  taskSpawn: {
    ts: '2026-03-05T12:00:10.000Z',
    kind: 'task.spawn',
    sessionID: 'ses_abc123',
    rootSessionID: 'ses_abc123',
    childSessionID: 'ses_child_001',
    subagentType: 'explorer'
  }
};

// Run tests
console.log('\n=== OpenCode Adapter Tests ===\n');

const adapter = new OpenCodeAdapter();

// Test 1: Init event
const initResult = adapter.translate(testEvents.init);
assert(initResult.event === 'session.start', 'Init translates to session.start');
assert(initResult.runner === 'opencode', 'Runner is set to opencode');
assert(initResult.data.directory === '/home/user/project', 'Directory is preserved');

// Test 2: Session created event
const sessionCreatedResult = adapter.translate(testEvents.sessionCreated);
assert(sessionCreatedResult.event === 'session.start', 'session.created translates to session.start');
assert(sessionCreatedResult.sessionId === 'ses_abc123', 'SessionId is preserved');
assert(sessionCreatedResult.data.title === 'Build a feature', 'Title is preserved');

// Test 3: Session updated event
const sessionUpdatedResult = adapter.translate(testEvents.sessionUpdated);
assert(sessionUpdatedResult.event === 'session.update', 'session.updated translates to session.update');
assert(sessionUpdatedResult.data.title === 'Build a feature - updated', 'Updated title is preserved');

// Test 4: Tool before event
const toolBeforeResult = adapter.translate(testEvents.toolBefore);
assert(toolBeforeResult.event === 'tool.start', 'tool.before translates to tool.start');
assert(toolBeforeResult.traceId === 'call_read_1', 'traceId is set from callID');
assert(toolBeforeResult.data.tool === 'read', 'Tool name is preserved');

// Test 5: Tool after event
const toolAfterResult = adapter.translate(testEvents.toolAfter);
assert(toolAfterResult.event === 'tool.end', 'tool.after translates to tool.end');
assert(toolAfterResult.traceId === 'call_read_1', 'traceId matches tool.start');
assert(toolAfterResult.data.tool === 'read', 'Tool name is preserved');
assert(toolAfterResult.data.durationMs === 42, 'Duration is preserved');
assert(toolAfterResult.data.status === 'success', 'Status is inferred as success');
assert(toolAfterResult.data.outputLen === 1024, 'Output length is preserved');

// Test 6: Task spawn event
const taskSpawnResult = adapter.translate(testEvents.taskSpawn);
assert(taskSpawnResult.event === 'subagent.spawn', 'task.spawn translates to subagent.spawn');
assert(taskSpawnResult.data.childSessionId === 'ses_child_001', 'Child session ID is preserved');
assert(taskSpawnResult.data.subagentType === 'explorer', 'Subagent type is preserved');

// Test 7: Batch translation
adapter.reset();
const batch = [
  testEvents.init,
  testEvents.sessionCreated,
  testEvents.toolBefore,
  testEvents.toolAfter
];
const batchResult = adapter.translateBatch(batch);
assert(batchResult.length === 4, 'Batch translation returns correct number of events');
assert(batchResult[0].event === 'session.start', 'First batch event is correct');
assert(batchResult[3].event === 'tool.end', 'Last batch event is correct');

// Test 8: Null/undefined handling
const nullResult = adapter.translate(null);
assert(nullResult === null, 'Null input returns null');

const emptyResult = adapter.translate({});
assert(emptyResult === null, 'Empty object returns null');

// Test 9: Parent session detection
const subagentEvent = {
  ts: '2026-03-05T12:00:05.000Z',
  kind: 'tool.after',
  sessionID: 'ses_child_001',
  rootSessionID: 'ses_abc123',
  callID: 'call_read_2',
  tool: 'read',
  durationMs: 10,
  args: {},
  outputLen: 500
};
const subagentResult = adapter.translate(subagentEvent);
assert(subagentResult.parentSessionId === 'ses_abc123', 'Parent session ID is detected for subagent');

console.log('\n✅ All tests passed!\n');
