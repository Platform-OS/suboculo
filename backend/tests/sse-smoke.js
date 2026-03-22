#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3220;
const baseUrl = `http://127.0.0.1:${PORT}/api`;

function resolveNodeBinary() {
  if (process.env.SUBOCULO_NODE_BINARY) return process.env.SUBOCULO_NODE_BINARY;
  const candidates = [
    path.join(os.homedir(), '.config', 'nvm', 'versions', 'node', 'v20.20.0', 'bin', 'node'),
    process.execPath
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(server, getOutput, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (server.exitCode !== null) {
      const out = getOutput();
      throw new Error(`Server exited before startup (code ${server.exitCode})\n${out}`);
    }
    try {
      const res = await fetch(`${baseUrl}/stats`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error('Server did not start in time');
}

async function run() {
  const nodeBinary = resolveNodeBinary();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suboculo-sse-smoke-'));
  const dbPath = path.join(tmpDir, 'events.db');
  const server = spawn(nodeBinary, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SUBOCULO_PORT: String(PORT),
      SUBOCULO_DB_PATH: dbPath,
      SUBOCULO_LOG_LEVEL: 'warn'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  let stdout = '';
  server.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(server, () => `stdout:\n${stdout}\nstderr:\n${stderr}`);

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
    server.kill('SIGTERM');
    await sleep(100);
    if (!server.killed) server.kill('SIGKILL');
    if (stdout.trim()) {
      process.stdout.write(stdout);
    }
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  }
}

run().catch((error) => {
  console.error('SSE smoke failed:', error.stack || error.message);
  process.exit(1);
});
