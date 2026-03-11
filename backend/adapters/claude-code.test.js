/**
 * Tests for Claude Code to CEP Adapter
 * Simple standalone test runner - no framework required
 */

const ClaudeCodeAdapter = require('./claude-code');
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

console.log('Running ClaudeCodeAdapter tests...\n');

// Session Events
console.log('\nSession Events');
test('should translate session_start event', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'session_start',
    timestamp: '2026-03-05T12:00:00.000Z',
    sessionId: 'ses_123',
    title: 'Test session',
    directory: '/test/dir'
  };

  const result = adapter.translate(input);

  assert.strictEqual(result.event, 'session.start');
  assert.strictEqual(result.runner, 'claude-code');
  assert.strictEqual(result.sessionId, 'ses_123');
  assert.strictEqual(result.data.title, 'Test session');
  assert.strictEqual(result.data.directory, '/test/dir');
});

test('should translate session.start event (dot notation)', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'session.start',
    timestamp: '2026-03-05T12:00:00.000Z',
    sessionId: 'ses_123'
  };

  const result = adapter.translate(input);
  assert.strictEqual(result.event, 'session.start');
});

test('should translate session_end event', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'session_end',
    timestamp: '2026-03-05T13:00:00.000Z',
    sessionId: 'ses_123',
    reason: 'completed'
  };

  const result = adapter.translate(input);

  assert.strictEqual(result.event, 'session.end');
  assert.strictEqual(result.data.reason, 'completed');
});

// Tool Events
console.log('\nTool Events');
test('should translate tool_call_start event', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'tool_call_start',
    timestamp: '2026-03-05T12:00:01.000Z',
    sessionId: 'ses_123',
    traceId: 'trace_1',
    toolName: 'read',
    args: { filePath: '/test/file.txt' }
  };

  const result = adapter.translate(input);

  assert.strictEqual(result.event, 'tool.start');
  assert.strictEqual(result.runner, 'claude-code');
  assert.strictEqual(result.traceId, 'trace_1');
  assert.strictEqual(result.data.tool, 'read');
  assert.deepStrictEqual(result.data.args, { filePath: '/test/file.txt' });
});

test('should translate tool_call_end event with status', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'tool_call_end',
    timestamp: '2026-03-05T12:00:01.042Z',
    sessionId: 'ses_123',
    traceId: 'trace_1',
    toolName: 'read',
    durationMs: 42,
    status: 'success',
    outputLen: 1024
  };

  const result = adapter.translate(input);

  assert.strictEqual(result.event, 'tool.end');
  assert.strictEqual(result.traceId, 'trace_1');
  assert.strictEqual(result.data.tool, 'read');
  assert.strictEqual(result.data.durationMs, 42);
  assert.strictEqual(result.data.status, 'success');
  assert.strictEqual(result.data.outputLen, 1024);
});

test('should pair tool.start and tool.end events', () => {
  const adapter = new ClaudeCodeAdapter();
  const start = {
    event: 'tool_call_start',
    timestamp: '2026-03-05T12:00:01.000Z',
    sessionId: 'ses_123',
    traceId: 'trace_1',
    toolName: 'bash',
    args: { command: 'ls' }
  };

  const end = {
    event: 'tool_call_end',
    timestamp: '2026-03-05T12:00:01.150Z',
    sessionId: 'ses_123',
    traceId: 'trace_1',
    exitCode: 0
  };

  // Translate start
  const startResult = adapter.translate(start);
  assert.strictEqual(startResult.data.tool, 'bash');

  // Translate end - should pair with start
  const endResult = adapter.translate(end);
  assert.strictEqual(endResult.data.tool, 'bash'); // Inherited from start
  assert.strictEqual(endResult.data.durationMs, 150); // Calculated
  assert.strictEqual(endResult.data.status, 'success'); // From exitCode
});

test('should generate traceId if missing', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'tool_call_start',
    timestamp: '2026-03-05T12:00:01.000Z',
    sessionId: 'ses_123',
    toolName: 'read'
  };

  const result = adapter.translate(input);

  assert.ok(result.traceId);
  assert.ok(result.traceId.includes('read'));
});

// Status Inference
console.log('\nStatus Inference');
test('should infer success from exitCode 0', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'tool_call_end',
    timestamp: '2026-03-05T12:00:01.100Z',
    traceId: 'trace_1',
    toolName: 'bash',
    exitCode: 0
  };

  const result = adapter.translate(input);
  assert.strictEqual(result.data.status, 'success');
});

test('should infer error from non-zero exitCode', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'tool_call_end',
    timestamp: '2026-03-05T12:00:01.100Z',
    traceId: 'trace_1',
    toolName: 'bash',
    exitCode: 1
  };

  const result = adapter.translate(input);
  assert.strictEqual(result.data.status, 'error');
});

test('should infer error from error field', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'tool_call_end',
    timestamp: '2026-03-05T12:00:01.100Z',
    traceId: 'trace_1',
    toolName: 'read',
    error: 'File not found'
  };

  const result = adapter.translate(input);
  assert.strictEqual(result.data.status, 'error');
});

test('should infer timeout status', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'tool_call_end',
    timestamp: '2026-03-05T12:00:01.100Z',
    traceId: 'trace_1',
    toolName: 'bash',
    timeout: true
  };

  const result = adapter.translate(input);
  assert.strictEqual(result.data.status, 'timeout');
});

test('should use explicit status field', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'tool_call_end',
    timestamp: '2026-03-05T12:00:01.100Z',
    traceId: 'trace_1',
    toolName: 'read',
    status: 'success',
    exitCode: 1 // Explicit status takes precedence
  };

  const result = adapter.translate(input);
  assert.strictEqual(result.data.status, 'success');
});

// Other Event Types
console.log('\nOther Event Types');
test('should translate message event', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'message',
    timestamp: '2026-03-05T12:00:02.000Z',
    sessionId: 'ses_123',
    role: 'assistant',
    contentPreview: 'I will help you with that task...'
  };

  const result = adapter.translate(input);

  assert.strictEqual(result.event, 'message');
  assert.strictEqual(result.data.role, 'assistant');
  assert.strictEqual(result.data.contentPreview, 'I will help you with that task...');
});

test('should translate error event', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'error',
    timestamp: '2026-03-05T12:00:03.000Z',
    sessionId: 'ses_123',
    message: 'Connection timeout',
    code: 'ETIMEDOUT'
  };

  const result = adapter.translate(input);

  assert.strictEqual(result.event, 'error');
  assert.strictEqual(result.data.message, 'Connection timeout');
  assert.strictEqual(result.data.code, 'ETIMEDOUT');
});

test('should translate subagent_spawn event', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'subagent_spawn',
    timestamp: '2026-03-05T12:00:04.000Z',
    sessionId: 'ses_123',
    childSessionId: 'ses_456',
    subagentType: 'explorer'
  };

  const result = adapter.translate(input);

  assert.strictEqual(result.event, 'subagent.spawn');
  assert.strictEqual(result.data.childSessionId, 'ses_456');
  assert.strictEqual(result.data.subagentType, 'explorer');
});

test('should translate unknown events as custom', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'custom_event_type',
    timestamp: '2026-03-05T12:00:05.000Z',
    sessionId: 'ses_123',
    data: { foo: 'bar' }
  };

  const result = adapter.translate(input);

  assert.strictEqual(result.event, 'custom');
  assert.strictEqual(result.data.originalEvent, 'custom_event_type');
  assert.strictEqual(result.data.foo, 'bar');
});

// Batch Translation
console.log('\nBatch Translation');
test('should translate multiple events', () => {
  const adapter = new ClaudeCodeAdapter();
  const events = [
    {
      event: 'session_start',
      timestamp: '2026-03-05T12:00:00.000Z',
      sessionId: 'ses_123'
    },
    {
      event: 'tool_call_start',
      timestamp: '2026-03-05T12:00:01.000Z',
      sessionId: 'ses_123',
      traceId: 'trace_1',
      toolName: 'read'
    },
    {
      event: 'tool_call_end',
      timestamp: '2026-03-05T12:00:01.042Z',
      sessionId: 'ses_123',
      traceId: 'trace_1',
      status: 'success'
    }
  ];

  const results = adapter.translateBatch(events);

  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[0].event, 'session.start');
  assert.strictEqual(results[1].event, 'tool.start');
  assert.strictEqual(results[2].event, 'tool.end');
});

// Edge Cases
console.log('\nEdge Cases');
test('should return null for events without event type', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    timestamp: '2026-03-05T12:00:00.000Z',
    sessionId: 'ses_123'
  };

  const result = adapter.translate(input);
  assert.strictEqual(result, null);
});

test('should handle missing timestamp', () => {
  const adapter = new ClaudeCodeAdapter();
  const input = {
    event: 'session_start',
    sessionId: 'ses_123'
  };

  const result = adapter.translate(input);

  assert.ok(result.ts);
  assert.ok(new Date(result.ts).getTime() > 0);
});

test('should handle snake_case and camelCase field names', () => {
  const adapter = new ClaudeCodeAdapter();
  const snakeCase = {
    event: 'tool_call_start',
    timestamp: '2026-03-05T12:00:01.000Z',
    session_id: 'ses_123',
    trace_id: 'trace_1',
    tool_name: 'read'
  };

  const result = adapter.translate(snakeCase);

  assert.strictEqual(result.sessionId, 'ses_123');
  assert.strictEqual(result.traceId, 'trace_1');
  assert.strictEqual(result.data.tool, 'read');
});

test('should reset adapter state', () => {
  const adapter = new ClaudeCodeAdapter();
  adapter.translate({
    event: 'tool_call_start',
    timestamp: '2026-03-05T12:00:01.000Z',
    traceId: 'trace_1',
    toolName: 'read'
  });

  assert.strictEqual(adapter.pendingToolCalls.size, 1);

  adapter.reset();

  assert.strictEqual(adapter.pendingToolCalls.size, 0);
});

console.log(`\n\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
