#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3221;
const baseUrl = `http://127.0.0.1:${PORT}/api`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(server, getOutput, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (server.exitCode !== null) {
      throw new Error(`Server exited before startup (code ${server.exitCode})\n${getOutput()}`);
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

async function ingestEvents(events) {
  const result = await request('/ingest/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(events)
  });
  assert.equal(result.response.status, 200, 'batch ingest should succeed');
  assert.equal(result.body.count, events.length, 'batch ingest count should match input size');
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suboculo-reliability-smoke-'));
  const dbPath = path.join(tmpDir, 'events.db');
  const thresholdsPath = path.join(tmpDir, 'thresholds.json');
  fs.writeFileSync(thresholdsPath, JSON.stringify({
    success_rate: { min: 0.7, severity: 'medium' },
    retry_rate: { max: 0.25, severity: 'high' }
  }, null, 2));

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SUBOCULO_PORT: String(PORT),
      SUBOCULO_DB_PATH: dbPath,
      SUBOCULO_THRESHOLDS_PATH: thresholdsPath,
      SUBOCULO_LOG_LEVEL: 'warn'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  server.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(server, () => `stdout:\n${stdout}\nstderr:\n${stderr}`);

    await ingestEvents([
      {
        ts: '2026-03-24T10:00:00.000Z',
        event: 'session.start',
        runner: 'reliability-smoke',
        sessionId: 'reliability-session-1',
        data: {
          title: 'Reliability smoke attempt 1',
          directory: '/tmp/reliability-smoke'
        }
      },
      {
        ts: '2026-03-24T10:00:01.000Z',
        event: 'tool.start',
        runner: 'reliability-smoke',
        sessionId: 'reliability-session-1',
        traceId: 'reliability-trace-1',
        data: {
          tool: 'read',
          args: { filePath: '/tmp/reliability-smoke/input.txt' }
        }
      },
      {
        ts: '2026-03-24T10:00:01.020Z',
        event: 'tool.end',
        runner: 'reliability-smoke',
        sessionId: 'reliability-session-1',
        traceId: 'reliability-trace-1',
        data: {
          tool: 'read',
          status: 'success',
          durationMs: 20
        }
      },
      {
        ts: '2026-03-24T10:00:01.100Z',
        event: 'usage',
        runner: 'reliability-smoke',
        sessionId: 'reliability-session-1',
        data: {
          model: 'reliability-model-20260324',
          inputTokens: 32,
          outputTokens: 18,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: 0.05
        }
      },
      {
        ts: '2026-03-24T10:00:02.000Z',
        event: 'session.end',
        runner: 'reliability-smoke',
        sessionId: 'reliability-session-1',
        data: { reason: 'completed' }
      },
      {
        ts: '2026-03-25T11:30:00.000Z',
        event: 'session.start',
        runner: 'reliability-smoke',
        sessionId: 'reliability-session-1',
        data: {
          title: 'Reliability smoke attempt 2',
          directory: '/tmp/reliability-smoke'
        }
      },
      {
        ts: '2026-03-25T11:30:01.000Z',
        event: 'tool.start',
        runner: 'reliability-smoke',
        sessionId: 'reliability-session-1',
        traceId: 'reliability-trace-2a',
        data: {
          tool: 'write',
          args: { filePath: '/tmp/reliability-smoke/output.txt' }
        }
      },
      {
        ts: '2026-03-25T11:30:01.020Z',
        event: 'tool.end',
        runner: 'reliability-smoke',
        sessionId: 'reliability-session-1',
        traceId: 'reliability-trace-2a',
        data: {
          tool: 'write',
          status: 'error',
          durationMs: 20
        }
      },
      {
        ts: '2026-03-25T11:30:01.050Z',
        event: 'error',
        runner: 'reliability-smoke',
        sessionId: 'reliability-session-1',
        data: {
          message: 'write failed'
        }
      },
      {
        ts: '2026-03-25T11:30:01.150Z',
        event: 'tool.start',
        runner: 'reliability-smoke',
        sessionId: 'reliability-session-1',
        traceId: 'reliability-trace-2b',
        data: {
          tool: 'write',
          args: { filePath: '/tmp/reliability-smoke/output.txt' }
        }
      },
      {
        ts: '2026-03-25T11:30:01.200Z',
        event: 'tool.end',
        runner: 'reliability-smoke',
        sessionId: 'reliability-session-1',
        traceId: 'reliability-trace-2b',
        data: {
          tool: 'write',
          status: 'success',
          durationMs: 50
        }
      },
      {
        ts: '2026-03-25T11:30:01.250Z',
        event: 'usage',
        runner: 'reliability-smoke',
        sessionId: 'reliability-session-1',
        data: {
          model: 'reliability-model-20260324',
          inputTokens: 48,
          outputTokens: 27,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: 0.08
        }
      }
    ]);

    let result = await request('/task-runs/derive', { method: 'POST' });
    assert.equal(result.response.status, 200, 'task run derivation should succeed');
    assert.equal(result.body.derived, 2, 'task run derivation should produce two attempts');

    result = await request('/task-runs?pageSize=10&runner=reliability-smoke');
    assert.equal(result.response.status, 200, 'task runs listing should succeed');
    assert.equal(result.body.total, 2, 'task runs should be split into two attempts');
    const completedRun = result.body.taskRuns.find((row) => row.status === 'completed');
    const activeRun = result.body.taskRuns.find((row) => row.status !== 'completed');
    assert.ok(completedRun, 'one completed task run should exist');
    assert.ok(activeRun, 'one active task run should exist');
    assert.equal(completedRun.model, 'reliability-model', 'task run should normalize model version suffix');
    assert.equal(activeRun.retry_count, 1, 'second attempt should record retry pressure');

    result = await request(`/task-runs/${completedRun.id}`);
    assert.equal(result.response.status, 200, 'completed task run detail should succeed');
    const autoCanonical = result.body.outcomes.find((row) => row.is_canonical);
    assert.ok(autoCanonical, 'completed run should receive auto canonical outcome');
    assert.equal(autoCanonical.outcome_label, 'success', 'completed run should auto-label as success');

    result = await request(`/task-runs/${activeRun.id}/outcomes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evaluation_type: 'human',
        outcome_label: 'failure',
        failure_mode: 'execution_failure',
        failure_subtype: 'wrong_edit',
        evaluator: 'reliability-smoke',
        is_canonical: true
      })
    });
    assert.equal(result.response.status, 200, 'manual canonical outcome should succeed');

    result = await request(`/task-runs/${activeRun.id}/after-action-report`);
    assert.equal(result.response.status, 200, 'after-action report should succeed');
    assert.equal(result.body.status, 'ready', 'labeled task run report should be ready');
    assert.equal(result.body.canonical_outcome?.failure_mode, 'execution_failure', 'report should surface failure mode');
    assert.equal(result.body.cache?.source, 'generated', 'first report read should generate report');

    result = await request('/reliability/kpis?runner=reliability-smoke&source=derived_attempt');
    assert.equal(result.response.status, 200, 'reliability KPI endpoint should succeed');
    assert.equal(result.body.counts.task_runs, 2, 'KPI should include both attempts');
    assert.equal(result.body.counts.with_canonical_outcome, 2, 'KPI should include canonical outcomes for both attempts');
    assert.equal(result.body.rates.success_rate, 0.5, 'KPI should compute success rate across two attempts');
    assert.equal(result.body.rates.retry_rate, 0.5, 'KPI should compute retry rate from one retrying run');

    result = await request('/reliability/review?runner=reliability-smoke&source=derived_attempt&bucket=day&window_days=7');
    assert.equal(result.response.status, 200, 'reliability review endpoint should succeed');
    assert.ok(Array.isArray(result.body.anomalies), 'review should expose anomalies');
    assert.ok(Array.isArray(result.body.top_failing_runs), 'review should expose top failing runs');
    assert.ok(typeof result.body.markdown === 'string' && result.body.markdown.includes('Reliability Review'), 'review should include markdown');

    result = await request('/reliability/trends?runner=reliability-smoke&source=derived_attempt&bucket=day&window_days=7');
    assert.equal(result.response.status, 200, 'reliability trends endpoint should succeed');
    assert.ok(Array.isArray(result.body.series), 'trends should return a series');
    assert.equal(result.body.series.length, 2, 'trend series should expose two daily buckets');
    assert.ok(result.body.series.some((row) => row.success_count === 1), 'trend data should include success bucket');
    assert.ok(result.body.series.some((row) => row.failure_count === 1), 'trend data should include failure bucket');

    result = await request('/reliability/trends/failure-modes?runner=reliability-smoke&source=derived_attempt&bucket=day&window_days=7');
    assert.equal(result.response.status, 200, 'failure mode trends endpoint should succeed');
    assert.ok(
      result.body.series.some((row) => Array.isArray(row.by_mode) && row.by_mode.some((modeRow) => modeRow.failure_mode === 'execution_failure')),
      'failure mode trends should surface execution_failure'
    );

    console.log('Reliability smoke passed');
  } finally {
    server.kill('SIGINT');
    await new Promise((resolve) => server.on('exit', resolve));
    if (stdout.trim()) process.stdout.write(stdout);
    if (stderr.trim()) process.stderr.write(stderr);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('Reliability smoke failed:', error.stack || error.message);
  process.exit(1);
});
