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
  const thresholdsPath = path.join(tmpDir, 'thresholds.json');
  fs.writeFileSync(thresholdsPath, JSON.stringify({
    retry_rate: { max: 0.1, severity: 'high' },
    success_rate: { min: 0.6, severity: 'medium' }
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
        ts: '2026-03-19T10:00:01.030Z',
        event: 'usage',
        runner: 'smoke-runner',
        sessionId: 'smoke-session-1',
        data: {
          model: 'smoke-model',
          inputTokens: 12,
          outputTokens: 8,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: 0
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
    assert.equal(result.body.count, 7);

    result = await request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'tool.start' })
    });
    assert.equal(result.response.status, 400, 'invalid ingest should fail');

    result = await request('/entries?pageSize=10&runner=smoke-runner');
    assert.equal(result.response.status, 200, 'entries fetch should succeed');
    assert.equal(result.body.total, 8);
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
    const completedRun = result.body.taskRuns.find((row) => row.status === 'completed');
    const activeRun = result.body.taskRuns.find((row) => row.status !== 'completed');
    assert.ok(completedRun, 'dataset should include one completed run for auto-label checks');
    assert.ok(activeRun, 'dataset should include one active run');
    const smokeTaskRunId = activeRun.id;
    const secondSmokeTaskRunId = completedRun.id;

    result = await request('/task-runs?pageSize=10&runner=smoke-runner&has_canonical_outcome=false');
    assert.equal(result.response.status, 200, 'has_canonical_outcome=false filter should succeed');
    assert.equal(result.body.total, 1, 'only non-auto-labeled runs should require labeling');

    result = await request(`/task-runs/${secondSmokeTaskRunId}`);
    assert.equal(result.response.status, 200, 'completed run detail should succeed');
    const autoCanonical = (result.body.outcomes || []).find((o) => o.is_canonical);
    assert.ok(autoCanonical, 'completed run should have auto canonical outcome');
    assert.equal(autoCanonical.evaluation_type, 'rule_based', 'auto label should use rule_based evaluation type');
    assert.equal(autoCanonical.outcome_label, 'success', 'auto label should mark run as success');
    assert.equal(autoCanonical.evaluator, 'auto-labeler/v1', 'auto label should include evaluator provenance');

    result = await request(`/task-runs/${smokeTaskRunId}/after-action-report`);
    assert.equal(result.response.status, 200, 'after-action report should be available for task run');
    assert.equal(result.body.status, 'insufficient_evidence', 'report should flag missing canonical outcome');
    assert.ok(result.body.sections && Array.isArray(result.body.sections.variance_vs_expected), 'report should include structured sections');
    assert.ok(typeof result.body.markdown === 'string' && result.body.markdown.includes('After-Action Report'), 'report should include markdown output');
    assert.equal(result.body.cache?.source, 'generated', 'first report request should generate and persist report');
    const initialAarGeneratedAt = result.body.generated_at;

    result = await request(`/task-runs/${smokeTaskRunId}/after-action-report`);
    assert.equal(result.response.status, 200, 'cached after-action report should be available');
    assert.equal(result.body.cache?.source, 'db', 'second report request should come from persisted cache');
    assert.equal(result.body.generated_at, initialAarGeneratedAt, 'cached report should preserve generated_at');

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
    assert.ok(smokeRunnerKpiBeforeOutcomes.counts.with_canonical_outcome >= 1, 'auto-labeling should provide at least one canonical outcome');
    assert.ok(smokeRunnerKpiBeforeOutcomes.counts.successful_runs_with_known_cost >= 1, 'known-cost success counter should be populated');
    assert.ok(smokeRunnerKpiBeforeOutcomes.rates.success_rate != null, 'success rate should be computable with auto-labeling');
    assert.ok(smokeRunnerKpiBeforeOutcomes.cost.cost_per_success != null, 'cost per success should be computed when auto-labeled success exists');
    assert.ok(smokeRunnerKpiBeforeOutcomes.anomalies.some((a) => a.code === 'unstable_cost_per_success'), 'small success sample should flag unstable cost-per-success');

    result = await request('/reliability/review?runner=smoke-runner&source=derived_attempt&bucket=week');
    assert.equal(result.response.status, 200, 'reliability review endpoint should succeed before outcomes');
    assert.ok(result.body.kpis && result.body.kpis.counts, 'review should include kpi snapshot');
    assert.ok(result.body.labeling_backlog?.no_canonical_outcome_runs >= 1, 'review should include labeling backlog');
    assert.ok(result.body.thresholds?.targets?.retry_rate, 'review should include configured thresholds');
    assert.ok(typeof result.body.markdown === 'string' && result.body.markdown.includes('Reliability Review'), 'review should include markdown output');

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

    result = await request(`/task-runs/${smokeTaskRunId}/after-action-report`);
    assert.equal(result.response.status, 200, 'after-action report should succeed after labeling');
    assert.equal(result.body.status, 'ready', 'report should be ready when canonical outcome is present');
    assert.equal(result.body.canonical_outcome?.outcome_label, 'failure', 'report should include canonical outcome');
    assert.ok(Array.isArray(result.body.sections?.risks), 'report should include risks section');
    assert.equal(result.body.cache?.source, 'generated', 'report should regenerate after outcome change');
    const labeledAarGeneratedAt = result.body.generated_at;
    assert.notEqual(labeledAarGeneratedAt, initialAarGeneratedAt, 'regenerated report should have a new generated_at');

    result = await request(`/task-runs/${smokeTaskRunId}/after-action-report`);
    assert.equal(result.response.status, 200, 'cached labeled after-action report should be available');
    assert.equal(result.body.cache?.source, 'db', 'labeled report should persist in DB cache');
    assert.equal(result.body.generated_at, labeledAarGeneratedAt, 'cached labeled report should preserve generated_at');

    result = await request('/reliability/review?runner=smoke-runner&source=derived_attempt&bucket=week');
    assert.equal(result.response.status, 200, 'reliability review endpoint should succeed after outcomes');
    assert.ok(Array.isArray(result.body.top_failing_runs), 'review should include top failing runs list');
    assert.ok(Array.isArray(result.body.anomalies), 'review should include anomaly list');

    // Re-derive should not overwrite existing human canonical outcomes
    result = await request('/task-runs/derive', { method: 'POST' });
    assert.equal(result.response.status, 200, 'task run re-derivation should succeed');
    result = await request(`/task-runs/${smokeTaskRunId}`);
    assert.equal(result.response.status, 200, 'active run detail should succeed after re-derive');
    const canonicalAfterRebuild = (result.body.outcomes || []).find((o) => o.is_canonical);
    assert.ok(canonicalAfterRebuild, 'active run should retain canonical outcome');
    assert.equal(canonicalAfterRebuild.evaluation_type, 'human', 'human canonical outcome must not be overwritten by auto-labeler');
    assert.equal(canonicalAfterRebuild.outcome_label, 'failure', 'human canonical outcome label should remain unchanged');

    result = await request('/reliability/kpis?runner=smoke-runner&source=derived_attempt');
    assert.equal(result.response.status, 200, 'reliability KPI endpoint should succeed');
    assert.equal(result.body.counts.task_runs, 2, 'KPI counts should include two attempt task runs');
    assert.ok(result.body.counts.with_canonical_outcome >= 1, 'KPI counts should include canonical outcomes');
    assert.ok(result.body.counts.runs_with_known_cost >= 1, 'KPI counts should include known-cost runs');
    assert.ok(result.body.rates.retry_rate != null, 'KPI retry rate should be present');
    assert.ok(result.body.cost.total_estimated_cost >= 0, 'KPI cost aggregate should be non-negative');

    result = await request('/reliability/kpis/compare?runner=smoke-runner&source=derived_attempt&period_days=7');
    assert.equal(result.response.status, 200, 'reliability KPI compare endpoint should succeed');
    assert.ok(result.body.period_a && result.body.period_b, 'KPI compare should include both periods');
    assert.ok(result.body.deltas && result.body.deltas.rates, 'KPI compare should include deltas');
    assert.ok(Array.isArray(result.body.period_a.anomalies), 'KPI compare should include period anomalies');

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
    assert.equal(result.body.total, 8);

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
