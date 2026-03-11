/**
 * Test Claude Code Event Ingestion
 *
 * This script tests the full flow:
 * 1. Claude Code event → 2. Adapter translation → 3. API ingestion → 4. Database storage
 */

const ClaudeCodeAdapter = require('./adapters/claude-code');
const http = require('http');

const BACKEND_URL = process.env.AGENT_VIEWER_URL || 'http://localhost:3000';

// Sample Claude Code events
const sampleEvents = [
  {
    event: 'session_start',
    timestamp: new Date().toISOString(),
    sessionId: 'claude_test_session_001',
    title: 'Testing Claude Code Integration',
    directory: '/srv/Projects/agent-actions-viewer',
    model: 'claude-sonnet-4-5'
  },
  {
    event: 'tool_call_start',
    timestamp: new Date(Date.now() + 1000).toISOString(),
    sessionId: 'claude_test_session_001',
    traceId: 'claude_read_001',
    toolName: 'read',
    args: {
      filePath: '/srv/Projects/agent-actions-viewer/README.md'
    }
  },
  {
    event: 'tool_call_end',
    timestamp: new Date(Date.now() + 1050).toISOString(),
    sessionId: 'claude_test_session_001',
    traceId: 'claude_read_001',
    toolName: 'read',
    durationMs: 50,
    exitCode: 0,
    outputLen: 2048,
    outputPreview: '# Agent Actions Viewer\n\nA runner-agnostic monitoring system...'
  },
  {
    event: 'tool_call_start',
    timestamp: new Date(Date.now() + 2000).toISOString(),
    sessionId: 'claude_test_session_001',
    traceId: 'claude_bash_001',
    toolName: 'bash',
    args: {
      command: 'ls -la'
    }
  },
  {
    event: 'tool_call_end',
    timestamp: new Date(Date.now() + 2100).toISOString(),
    sessionId: 'claude_test_session_001',
    traceId: 'claude_bash_001',
    toolName: 'bash',
    durationMs: 100,
    exitCode: 0,
    outputLen: 512
  },
  {
    event: 'message',
    timestamp: new Date(Date.now() + 3000).toISOString(),
    sessionId: 'claude_test_session_001',
    role: 'assistant',
    contentPreview: 'I have successfully read the README file and executed the ls command. The project structure looks good!'
  },
  {
    event: 'session_end',
    timestamp: new Date(Date.now() + 4000).toISOString(),
    sessionId: 'claude_test_session_001',
    reason: 'completed'
  }
];

/**
 * Send CEP event to ingestion endpoint
 */
function ingestEvent(cepEvent) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BACKEND_URL}/api/ingest`);
    const payload = JSON.stringify(cepEvent);

    const options = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Main test execution
 */
async function main() {
  console.log('Testing Claude Code Event Ingestion\n');
  console.log('='.repeat(50));

  const adapter = new ClaudeCodeAdapter();

  console.log(`\n1. Translating ${sampleEvents.length} Claude Code events to CEP format...\n`);

  const cepEvents = adapter.translateBatch(sampleEvents);

  console.log(`   ✓ Translated ${cepEvents.length} events`);
  console.log(`   Events: ${cepEvents.map(e => e.event).join(', ')}`);

  console.log(`\n2. Ingesting events to ${BACKEND_URL}/api/ingest...\n`);

  let ingested = 0;
  let failed = 0;

  for (const cepEvent of cepEvents) {
    try {
      const result = await ingestEvent(cepEvent);
      console.log(`   ✓ ${cepEvent.event.padEnd(15)} [${cepEvent.traceId || cepEvent.sessionId}]`);
      ingested++;
    } catch (error) {
      console.log(`   ✗ ${cepEvent.event.padEnd(15)} - ${error.message}`);
      failed++;
    }
  }

  console.log(`\n3. Summary:\n`);
  console.log(`   Ingested: ${ingested}`);
  console.log(`   Failed:   ${failed}`);

  if (ingested > 0) {
    console.log(`\n4. Verify in viewer:\n`);
    console.log(`   Frontend: http://localhost:5173`);
    console.log(`   API:      ${BACKEND_URL}/api/entries?runner=claude-code`);
    console.log(`   Facets:   ${BACKEND_URL}/api/facets`);

    console.log(`\n   Filter by session:`);
    console.log(`   ${BACKEND_URL}/api/entries?sessionID=claude_test_session_001`);
  }

  console.log('\n' + '='.repeat(50));
  console.log(ingested === cepEvents.length ? '✓ All tests passed!' : '✗ Some tests failed');

  process.exit(failed > 0 ? 1 : 0);
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('\n✗ Test failed:', error.message);
    console.error('\nMake sure the backend server is running:');
    console.error('  cd backend && npm start');
    process.exit(1);
  });
}

module.exports = { ingestEvent };
