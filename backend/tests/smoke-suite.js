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
      },
      {
        ts: '2026-03-20T10:45:00.000Z',
        event: 'session.start',
        runner: 'smoke-runner',
        sessionId: 'smoke-session-1',
        data: {
          title: 'Smoke test session attempt 2',
          directory: '/tmp/project'
        }
      },
      {
        ts: '2026-03-20T10:45:01.000Z',
        event: 'tool.start',
        runner: 'smoke-runner',
        sessionId: 'smoke-session-1',
        traceId: 'trace-2',
        data: {
          tool: 'write',
          args: { filePath: '/tmp/project/output.txt' }
        }
      },
      {
        ts: '2026-03-20T10:45:01.020Z',
        event: 'tool.end',
        runner: 'smoke-runner',
        sessionId: 'smoke-session-1',
        traceId: 'trace-2',
        data: {
          tool: 'write',
          args: { filePath: '/tmp/project/output.txt' },
          status: 'success',
          durationMs: 20,
          outputLen: 64
        }
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
    assert.equal(result.body.count, 6);

    result = await request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'tool.start' })
    });
    assert.equal(result.response.status, 400, 'invalid ingest should fail');

    result = await request('/entries?pageSize=10&runner=smoke-runner');
    assert.equal(result.response.status, 200, 'entries fetch should succeed');
    assert.equal(result.body.total, 7);
    const firstKey = result.body.entries[0].__key;

    result = await request('/meta/outcome-taxonomy');
    assert.equal(result.response.status, 200, 'outcome taxonomy should be available');
    assert.ok(Array.isArray(result.body.evaluation_types), 'taxonomy should include evaluation_types');
    assert.ok(Array.isArray(result.body.outcome_labels), 'taxonomy should include outcome_labels');
    assert.ok(Array.isArray(result.body.failure_modes), 'taxonomy should include failure_modes');
    assert.ok(result.body.failure_taxonomy && typeof result.body.failure_taxonomy === 'object', 'taxonomy should include failure_taxonomy');

    result = await request('/task-runs/derive', {
      method: 'POST'
    });
    assert.equal(result.response.status, 200, 'task run derivation should succeed');
    assert.ok(result.body.derived >= 1, 'at least one task run should be derived');

    result = await request('/task-runs?pageSize=10&runner=smoke-runner');
    assert.equal(result.response.status, 200, 'task run listing should succeed');
    assert.equal(result.body.total, 2, 'attempt-level derivation should split into two task runs');
    assert.ok(result.body.taskRuns.length >= 1, 'smoke runner should have task runs');
    assert.ok(Object.prototype.hasOwnProperty.call(result.body.taskRuns[0], 'model'), 'task run should expose model field');
    assert.ok(Object.prototype.hasOwnProperty.call(result.body.taskRuns[0], 'git_revision'), 'task run should expose git_revision field');
    const attemptKey = result.body.taskRuns[0].task_key;
    const smokeTaskRunId = result.body.taskRuns[0].id;
    const secondSmokeTaskRunId = result.body.taskRuns[1].id;

    result = await request('/task-runs?pageSize=10&runner=smoke-runner&has_canonical_outcome=false');
    assert.equal(result.response.status, 200, 'has_canonical_outcome=false filter should succeed');
    assert.equal(result.body.total, 2, 'all runs should initially require labeling');

    result = await request('/facets');
    assert.equal(result.response.status, 200, 'facets should include attempts');
    assert.ok(Array.isArray(result.body.attempts), 'facets.attempts should be an array');
    assert.ok(result.body.attempts.length >= 2, 'facets should include derived attempts');

    result = await request(`/entries?pageSize=50&runner=smoke-runner&attempt=${encodeURIComponent(attemptKey)}`);
    assert.equal(result.response.status, 200, 'entries filtered by attempt should succeed');
    assert.ok(result.body.total >= 1, 'attempt filter should return entries');
    assert.ok(result.body.entries.every((entry) => entry.attemptKey === attemptKey), 'all entries should match requested attempt');

    result = await request('/reliability/kpi-definitions');
    assert.equal(result.response.status, 200, 'kpi definitions endpoint should succeed');
    assert.ok(result.body.metrics && result.body.metrics.success_rate, 'kpi definitions should include success_rate');
    assert.ok(result.body.thresholds && result.body.thresholds.min_canonical_sample >= 1, 'kpi definitions should include thresholds');

    result = await request('/reliability/kpis/by-runner?source=derived_attempt');
    assert.equal(result.response.status, 200, 'reliability KPI by-runner endpoint should succeed');
    assert.ok(Array.isArray(result.body.by_runner), 'KPI by-runner should return array');
    assert.ok(result.body.by_runner.length >= 1, 'KPI by-runner should include at least one runner');
    const smokeRunnerKpiBeforeOutcomes = result.body.by_runner.find((row) => row.runner === 'smoke-runner');
    assert.ok(smokeRunnerKpiBeforeOutcomes, 'KPI by-runner should include smoke-runner before outcomes');
    assert.equal(smokeRunnerKpiBeforeOutcomes.counts.with_canonical_outcome, 0, 'before outcomes canonical count should be zero');
    assert.equal(smokeRunnerKpiBeforeOutcomes.rates.success_rate, null, 'success rate should be null without canonical outcomes');
    assert.equal(smokeRunnerKpiBeforeOutcomes.cost.cost_per_success, null, 'cost per success should be null without successful runs');
    assert.ok(smokeRunnerKpiBeforeOutcomes.anomalies.some((a) => a.code === 'no_canonical_outcomes'), 'should flag missing canonical outcomes');

    result = await request('/task-runs/outcomes/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            task_run_id: smokeTaskRunId,
            evaluation_type: 'human',
            outcome_label: 'partial_success',
            evaluator: 'smoke-suite',
            is_canonical: false
          },
          {
            task_run_id: 999999,
            evaluation_type: 'human',
            outcome_label: 'success'
          }
        ]
      })
    });
    assert.equal(result.response.status, 200, 'batch outcomes endpoint should succeed with partial results');
    assert.equal(result.body.status, 'partial', 'batch outcomes should report partial status');
    assert.equal(result.body.success_count, 1, 'batch outcomes should report one success');
    assert.equal(result.body.failure_count, 1, 'batch outcomes should report one failure');
    assert.ok(Array.isArray(result.body.results), 'batch outcomes should return per-item results');

    result = await request(`/task-runs/${smokeTaskRunId}/outcomes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evaluation_type: 'human',
        outcome_label: 'failure',
        failure_mode: 'execution_failure',
        failure_subtype: 'wrong_edit',
        evaluator: 'smoke-suite',
        is_canonical: true
      })
    });
    assert.equal(result.response.status, 200, 'valid outcome should be accepted');
    assert.equal(result.body.success, true);

    result = await request(`/task-runs/${secondSmokeTaskRunId}/outcomes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evaluation_type: 'human',
        outcome_label: 'success',
        evaluator: 'smoke-suite',
        is_canonical: true
      })
    });
    assert.equal(result.response.status, 200, 'second canonical outcome should be accepted');
    assert.equal(result.body.success, true);

    result = await request('/task-runs/outcome-summary?runner=smoke-runner');
    assert.equal(result.response.status, 200, 'task run outcome summary should succeed');
    assert.ok(result.body.totals.task_runs >= 1, 'summary should include task runs');
    assert.ok(result.body.totals.with_canonical_outcome >= 1, 'summary should include canonical outcomes');
    assert.ok(result.body.by_outcome_label.some((row) => row.value === 'failure'), 'summary should include failure outcome bucket');
    assert.ok(result.body.by_failure_mode.some((row) => row.value === 'execution_failure'), 'summary should include failure mode bucket');

    result = await request('/reliability/kpis?runner=smoke-runner&source=derived_attempt');
    assert.equal(result.response.status, 200, 'reliability KPI endpoint should succeed');
    assert.equal(result.body.counts.task_runs, 2, 'KPI counts should include two attempt task runs');
    assert.ok(result.body.counts.with_canonical_outcome >= 1, 'KPI counts should include canonical outcomes');
    assert.ok(result.body.rates.retry_rate != null, 'KPI retry rate should be present');
    assert.ok(result.body.cost.total_estimated_cost >= 0, 'KPI cost aggregate should be non-negative');

    result = await request('/reliability/kpis/by-runner?source=derived_attempt');
    assert.equal(result.response.status, 200, 'reliability KPI by-runner endpoint should succeed');
    const smokeRunnerKpi = result.body.by_runner.find((row) => row.runner === 'smoke-runner');
    assert.ok(smokeRunnerKpi, 'KPI by-runner should include smoke-runner');
    assert.equal(smokeRunnerKpi.counts.task_runs, 2, 'smoke-runner KPI should include two task runs');
    assert.ok(smokeRunnerKpi.anomalies.some((a) => a.code === 'low_sample_size'), 'small canonical sample should be flagged');
    assert.ok(smokeRunnerKpi.anomalies.some((a) => a.code === 'unstable_cost_per_success'), 'small success sample should flag unstable cost-per-success');

    result = await request('/reliability/trends?runner=smoke-runner&source=derived_attempt&bucket=day&window_days=7');
    assert.equal(result.response.status, 200, 'reliability trends endpoint should succeed');
    assert.equal(result.body.bucket, 'day', 'trend bucket should match query');
    assert.ok(Array.isArray(result.body.series), 'trend series should be an array');
    assert.ok(result.body.series.length >= 2, 'trend series should include at least two daily buckets');
    assert.ok(result.body.series.some((row) => row.failure_count >= 1), 'trends should include failure bucket');
    assert.ok(result.body.series.some((row) => row.success_count >= 1), 'trends should include success bucket');
    assert.ok(result.body.by_runner && result.body.by_runner['smoke-runner'], 'trends should include runner split');

    result = await request('/reliability/trends/insights?runner=smoke-runner&source=derived_attempt&bucket=day&window_days=7');
    assert.equal(result.response.status, 200, 'reliability trend insights endpoint should succeed');
    assert.ok(Array.isArray(result.body.deltas), 'trend insights should include deltas');
    assert.ok(result.body.deltas.length >= 1, 'trend insights should include at least one delta');
    assert.ok(result.body.deltas.some((d) => d.insufficient_sample === true), 'trend insights should flag insufficient sample for sparse buckets');
    assert.ok(result.body.insights && typeof result.body.insights === 'object', 'trend insights should include grouped insights');

    result = await request('/reliability/trends/failure-modes?runner=smoke-runner&source=derived_attempt&bucket=day&window_days=7');
    assert.equal(result.response.status, 200, 'reliability failure-mode trends endpoint should succeed');
    assert.equal(result.body.bucket, 'day', 'failure-mode trend bucket should match query');
    assert.ok(Array.isArray(result.body.series), 'failure-mode trend series should be an array');
    assert.ok(result.body.series.some((row) => row.with_failure_mode >= 1), 'failure-mode trends should include at least one failure-mode bucket');
    assert.ok(
      result.body.series.some((row) => Array.isArray(row.by_mode) && row.by_mode.some((modeRow) => modeRow.failure_mode === 'execution_failure')),
      'failure-mode trends should include execution_failure mode'
    );
    assert.ok(Array.isArray(result.body.insufficient_evidence), 'failure-mode trends should include insufficient evidence notes');

    result = await request('/task-runs?pageSize=10&runner=smoke-runner&canonical_outcome_label=failure&failure_mode=execution_failure');
    assert.equal(result.response.status, 200, 'task run filters by canonical outcome and failure mode should succeed');
    assert.ok(result.body.total >= 1, 'filtered task runs should include the smoke run');

    result = await request('/task-runs?pageSize=10&runner=smoke-runner&requires_human_intervention=true');
    assert.equal(result.response.status, 200, 'task run requires_human_intervention filter should succeed');
    assert.equal(result.body.total, 0, 'no task run should require human intervention in smoke dataset');

    result = await request(`/task-runs/${smokeTaskRunId}/outcomes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evaluation_type: 'human',
        outcome_label: 'failure',
        evaluator: 'smoke-suite'
      })
    });
    assert.equal(result.response.status, 400, 'failure outcome without failure_mode should be rejected');

    result = await request(`/task-runs/${smokeTaskRunId}/outcomes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evaluation_type: 'human',
        outcome_label: 'failure',
        failure_mode: 'execution_failure',
        failure_subtype: 'nonexistent_subtype',
        evaluator: 'smoke-suite'
      })
    });
    assert.equal(result.response.status, 400, 'invalid failure_subtype should be rejected');

    result = await request(`/task-runs/${smokeTaskRunId}/outcomes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evaluation_type: 'not_real',
        outcome_label: 'success',
        evaluator: 'smoke-suite'
      })
    });
    assert.equal(result.response.status, 400, 'invalid evaluation_type should be rejected');

    result = await request('/stats');
    assert.equal(result.response.status, 200, 'stats fetch should succeed');
    assert.equal(result.body.total, 7);

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
