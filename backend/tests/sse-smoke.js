#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleep, startInProcessServer, waitForServer } = require('./helpers/server-smoke');

const PORT = 3222;
const baseUrl = `http://127.0.0.1:${PORT}/api`;

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suboculo-sse-smoke-'));
  const dbPath = path.join(tmpDir, 'events.db');
  const thresholdsPath = path.join(tmpDir, 'thresholds.json');
  fs.writeFileSync(thresholdsPath, JSON.stringify({
    retry_rate: { max: 0.5, severity: 'medium' }
  }, null, 2));

  try {
    startInProcessServer({
      backendDir: path.join(__dirname, '..'),
      env: {
        SUBOCULO_PORT: PORT,
        SUBOCULO_DB_PATH: dbPath,
        SUBOCULO_THRESHOLDS_PATH: thresholdsPath,
        SUBOCULO_LOG_LEVEL: 'warn'
      }
    });
    await waitForServer(baseUrl, null, null);

    const streamResponse = await fetch(`${baseUrl}/events/stream`);
    assert.equal(streamResponse.status, 200, 'SSE endpoint should return 200');
    assert.ok(streamResponse.body, 'SSE response should include body stream');

    const targetEvent = {
      ts: '2026-03-22T01:00:00.000Z',
      event: 'tool.start',
      runner: 'sse-smoke',
      sessionId: 'sse-session-1',
      traceId: 'sse-trace-1',
      data: { tool: 'Read', args: { filePath: '/tmp/demo.txt' } }
    };

    await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(targetEvent)
    });

    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let received = null;
    const deadline = Date.now() + 8000;

    while (Date.now() < deadline && !received) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split('\n\n');
      buffer = messages.pop() || '';

      for (const msg of messages) {
        const lines = msg.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(line.slice('data: '.length));
            if (parsed.event === 'tool.start' && parsed.traceId === 'sse-trace-1') {
              received = parsed;
              break;
            }
          } catch {
            // ignore malformed lines
          }
        }
        if (received) break;
      }
    }

    reader.cancel().catch(() => {});

    assert.ok(received, 'SSE stream should emit ingested event');
    assert.equal(received.event, 'tool.start', 'SSE event type should match');
    assert.ok(received.__key, 'SSE event should include generated key');
    assert.equal(received.traceId, 'sse-trace-1', 'SSE event should preserve traceId');

    console.log('SSE smoke passed');
  } finally {
    await sleep(50);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  process.exit(0);
}

run().catch((error) => {
  console.error('SSE smoke failed:', error.stack || error.message);
  process.exit(1);
});
