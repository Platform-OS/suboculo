#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3219;
const baseUrl = `http://127.0.0.1:${PORT}/api`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
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

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suboculo-smoke-'));
  const dbPath = path.join(tmpDir, 'events.db');
  const server = spawn(process.execPath, ['server.js'], {
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
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer();

    const singleEvent = {
      ts: '2026-03-19T10:00:00.000Z',
      event: 'session.start',
      runner: 'smoke-runner',
      sessionId: 'smoke-session-1',
      data: {
        title: 'Smoke test session',
        directory: '/tmp/project'
      }
    };

    const batchEvents = [
      {
        ts: '2026-03-19T10:00:01.000Z',
        event: 'tool.start',
        runner: 'smoke-runner',
        sessionId: 'smoke-session-1',
        traceId: 'trace-1',
        data: {
          tool: 'read',
          args: { filePath: '/tmp/project/README.md' }
        }
      },
      {
        ts: '2026-03-19T10:00:01.020Z',
        event: 'tool.end',
        runner: 'smoke-runner',
        sessionId: 'smoke-session-1',
        traceId: 'trace-1',
        data: {
          tool: 'read',
          args: { filePath: '/tmp/project/README.md' },
          status: 'success',
          durationMs: 20,
          outputLen: 128
        }
      },
      {
        ts: '2026-03-19T10:00:02.000Z',
        event: 'session.end',
        runner: 'smoke-runner',
        sessionId: 'smoke-session-1',
        data: { reason: 'completed' }
      }
    ];

    let result = await request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(singleEvent)
    });
    assert.equal(result.response.status, 200, 'single ingest should succeed');
    assert.equal(result.body.success, true);

    result = await request('/ingest/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batchEvents)
    });
    assert.equal(result.response.status, 200, 'batch ingest should succeed');
    assert.equal(result.body.count, 3);

    result = await request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'tool.start' })
    });
    assert.equal(result.response.status, 400, 'invalid ingest should fail');

    result = await request('/entries?pageSize=10&runner=smoke-runner');
    assert.equal(result.response.status, 200, 'entries fetch should succeed');
    assert.equal(result.body.total, 4);
    const firstKey = result.body.entries[0].__key;

    result = await request('/stats');
    assert.equal(result.response.status, 200, 'stats fetch should succeed');
    assert.equal(result.body.total, 4);

    result = await request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryKey: firstKey, tag: 'smoke', action: 'add' })
    });
    assert.equal(result.response.status, 200, 'add tag should succeed');

    result = await request('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryKey: firstKey, note: 'smoke note' })
    });
    assert.equal(result.response.status, 200, 'set note should succeed');

    result = await request('/export');
    assert.equal(result.response.status, 200, 'export should succeed');
    assert.deepEqual(result.body.tagsByKey[firstKey], ['smoke']);
    assert.equal(result.body.notesByKey[firstKey], 'smoke note');

    result = await request('/selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [firstKey] })
    });
    assert.equal(result.response.status, 200, 'save selection should succeed');
    assert.equal(result.body.count, 1);

    result = await request('/selection');
    assert.equal(result.response.status, 200, 'get selection should succeed');
    assert.equal(result.body.count, 1);

    result = await request('/analyses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'smoke-model',
        event_count: 1,
        event_keys: [firstKey],
        analysis: 'Smoke analysis'
      })
    });
    assert.equal(result.response.status, 200, 'save analysis should succeed');
    const analysisId = result.body.analysisId;

    result = await request('/analyses-history');
    assert.equal(result.response.status, 200, 'list analyses should succeed');
    assert.equal(result.body.length, 1);

    result = await request(`/analyses-history/${analysisId}`);
    assert.equal(result.response.status, 200, 'get analysis should succeed');
    assert.equal(result.body.analysis, 'Smoke analysis');

    result = await request(`/analyses-history/${analysisId}`, {
      method: 'DELETE'
    });
    assert.equal(result.response.status, 200, 'delete analysis should succeed');

    result = await request('/notify/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([null, { ts: '2026-03-19T10:00:03.000Z', event: 'custom', runner: 'smoke-runner' }])
    });
    assert.equal(result.response.status, 200, 'notify batch should succeed');
    assert.equal(result.body.received, 2);
    assert.equal(result.body.emitted, 1);

    console.log('Smoke suite passed');
  } finally {
    server.kill('SIGINT');
    await new Promise(resolve => server.on('exit', resolve));
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('Smoke suite failed:', error.stack || error.message);
  process.exit(1);
});
