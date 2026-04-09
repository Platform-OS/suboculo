const {
  KPI_MIN_CANONICAL_SAMPLE,
  KPI_MIN_SUCCESS_SAMPLE_FOR_COST,
  KPI_TARGET_METRICS,
  DEFAULT_KPI_TARGETS
} = require('./taxonomy');

function quantile(values, q) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function floorToBucketStart(ts, bucket = 'day') {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;

  if (bucket === 'week') {
    const day = date.getUTCDay();
    const mondayOffset = (day + 6) % 7;
    return new Date(Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() - mondayOffset,
      0, 0, 0, 0
    ));
  }

  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0, 0, 0, 0
  ));
}

function addBucketSpan(startDate, bucket = 'day') {
  const end = new Date(startDate.getTime());
  if (bucket === 'week') end.setUTCDate(end.getUTCDate() + 7);
  else end.setUTCDate(end.getUTCDate() + 1);
  return end;
}

function ratioOrNull(numerator, denominator) {
  if (!denominator) return null;
  return +(numerator / denominator).toFixed(6);
}

function formatKpiValue(metric, value) {
  if (value == null) return 'null';
  if (metric === 'cost_per_success') return `$${Number(value).toFixed(4)}`;
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function parsePositiveIntOrDefault(value, fallbackValue) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallbackValue;
}

function deltaOrNull(currentValue, previousValue) {
  if (currentValue == null || previousValue == null) return null;
  return +(Number(currentValue) - Number(previousValue)).toFixed(6);
}

function createTrendBucket(startDate) {
  return {
    bucket_start: startDate.toISOString(),
    bucket_end: null,
    task_runs: 0,
    with_canonical_outcome: 0,
    success_count: 0,
    successful_runs_with_known_cost: 0,
    partial_success_count: 0,
    failure_count: 0,
    unsafe_success_count: 0,
    retry_runs: 0,
    runs_with_known_cost: 0,
    total_estimated_cost: 0,
    successful_estimated_cost: 0
  };
}

function createFailureModeTrendBucket(startDate) {
  return {
    bucket_start: startDate.toISOString(),
    bucket_end: null,
    task_runs: 0,
    with_canonical_outcome: 0,
    with_failure_mode: 0,
    mode_counts: new Map()
  };
}

function createReliabilityDomain({
  reliabilityRepository,
  reviewAcknowledgementsRepository,
  fs,
  logger,
  thresholdsPath,
  buildTaskRunsWhereClause,
  normalizeOptionalString
}) {
  let kpiTargetsCache = {
    mtimeMs: null,
    loadedPath: thresholdsPath,
    targets: DEFAULT_KPI_TARGETS
  };

  function normalizeKpiTargets(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const normalized = {};
    for (const [metric, rule] of Object.entries(input)) {
      if (!KPI_TARGET_METRICS.has(metric)) continue;
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
      const min = Number.isFinite(rule.min) ? rule.min : null;
      const max = Number.isFinite(rule.max) ? rule.max : null;
      if (min == null && max == null) continue;
      normalized[metric] = {
        min,
        max,
        severity: ['low', 'medium', 'high'].includes(rule.severity) ? rule.severity : 'medium'
      };
    }
    return normalized;
  }

  function getConfiguredKpiTargets() {
    try {
      const stat = fs.statSync(thresholdsPath);
      if (
        kpiTargetsCache.loadedPath === thresholdsPath &&
        kpiTargetsCache.mtimeMs === stat.mtimeMs
      ) {
        return kpiTargetsCache.targets;
      }
      const raw = fs.readFileSync(thresholdsPath, 'utf8');
      const parsed = JSON.parse(raw);
      const merged = {
        ...DEFAULT_KPI_TARGETS,
        ...normalizeKpiTargets(parsed)
      };
      kpiTargetsCache = {
        loadedPath: thresholdsPath,
        mtimeMs: stat.mtimeMs,
        targets: merged
      };
      return merged;
    } catch (error) {
      const missing = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
      if (!missing) {
        logger.warn(`[suboculo] Failed to load KPI thresholds from ${thresholdsPath}: ${error.message}`);
      }
      kpiTargetsCache = {
        loadedPath: thresholdsPath,
        mtimeMs: null,
        targets: DEFAULT_KPI_TARGETS
      };
      return DEFAULT_KPI_TARGETS;
    }
  }

  function finalizeTrendBucket(bucket) {
    const withCanonical = bucket.with_canonical_outcome;
    const success = bucket.success_count;
    const successfulWithKnownCost = bucket.successful_runs_with_known_cost;
    return {
      bucket_start: bucket.bucket_start,
      bucket_end: bucket.bucket_end,
      task_runs: bucket.task_runs,
      with_canonical_outcome: withCanonical,
      success_count: success,
      successful_runs_with_known_cost: successfulWithKnownCost,
      partial_success_count: bucket.partial_success_count,
      failure_count: bucket.failure_count,
      unsafe_success_count: bucket.unsafe_success_count,
      retry_runs: bucket.retry_runs,
      runs_with_known_cost: bucket.runs_with_known_cost,
      total_estimated_cost: +bucket.total_estimated_cost.toFixed(6),
      successful_estimated_cost: +bucket.successful_estimated_cost.toFixed(6),
      success_rate: ratioOrNull(success, withCanonical),
      partial_success_rate: ratioOrNull(bucket.partial_success_count, withCanonical),
      failure_rate: ratioOrNull(bucket.failure_count, withCanonical),
      retry_rate: ratioOrNull(bucket.retry_runs, bucket.task_runs),
      cost_per_success: ratioOrNull(bucket.successful_estimated_cost, successfulWithKnownCost)
    };
  }

  function buildReliabilityTrendsData(query = {}) {
    const bucket = query.bucket === 'week' ? 'week' : 'day';
    const windowDays = parsePositiveIntOrDefault(query.window_days, 30);
    const scopedQuery = { ...query };
    if (!scopedQuery.from && !scopedQuery.to) {
      scopedQuery.from = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    }

    const { whereSql, params } = buildTaskRunsWhereClause(scopedQuery, 'tr');
    const rows = reliabilityRepository.fetchTrendRows({ whereSql, params });

    const buckets = new Map();
    const byRunner = new Map();

    function upsertBucket(map, key, startDate) {
      if (!map.has(key)) {
        const base = createTrendBucket(startDate);
        base.bucket_end = addBucketSpan(startDate, bucket).toISOString();
        map.set(key, base);
      }
      return map.get(key);
    }

    for (const row of rows) {
      const start = floorToBucketStart(row.started_at, bucket);
      if (!start) continue;
      const key = start.toISOString();

      const globalBucket = upsertBucket(buckets, key, start);
      const runnerName = row.runner || 'unknown';
      if (!byRunner.has(runnerName)) byRunner.set(runnerName, new Map());
      const runnerBucket = upsertBucket(byRunner.get(runnerName), key, start);

      const targets = [globalBucket, runnerBucket];
      const hasKnownCost = Number(row.estimated_cost_known) === 1;
      for (const target of targets) {
        target.task_runs += 1;
        if (hasKnownCost) {
          target.runs_with_known_cost += 1;
          target.total_estimated_cost += row.estimated_cost || 0;
        }
        if ((row.retry_count || 0) > 0) target.retry_runs += 1;

        const label = row.canonical_outcome_label;
        if (label) {
          target.with_canonical_outcome += 1;
          if (label === 'success') {
            target.success_count += 1;
            if (hasKnownCost) {
              target.successful_runs_with_known_cost += 1;
              target.successful_estimated_cost += row.estimated_cost || 0;
            }
          } else if (label === 'partial_success') {
            target.partial_success_count += 1;
          } else if (label === 'failure') {
            target.failure_count += 1;
          } else if (label === 'unsafe_success') {
            target.unsafe_success_count += 1;
          }
        }
      }
    }

    const series = [...buckets.values()]
      .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start))
      .map(finalizeTrendBucket);

    const by_runner = {};
    for (const [runner, runnerBuckets] of byRunner.entries()) {
      by_runner[runner] = [...runnerBuckets.values()]
        .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start))
        .map(finalizeTrendBucket);
    }

    return {
      bucket,
      window_days: windowDays,
      from: scopedQuery.from || null,
      to: scopedQuery.to || null,
      series,
      by_runner
    };
  }

  function finalizeFailureModeTrendBucket(bucket) {
    const modes = [...bucket.mode_counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([failure_mode, count]) => ({
        failure_mode,
        count,
        failure_mode_share: ratioOrNull(count, bucket.with_failure_mode),
        canonical_share: ratioOrNull(count, bucket.with_canonical_outcome)
      }));

    return {
      bucket_start: bucket.bucket_start,
      bucket_end: bucket.bucket_end,
      task_runs: bucket.task_runs,
      with_canonical_outcome: bucket.with_canonical_outcome,
      with_failure_mode: bucket.with_failure_mode,
      top_failure_mode: modes.length ? modes[0].failure_mode : null,
      by_mode: modes
    };
  }

  function buildFailureModeTrendsData(query = {}) {
    const bucket = query.bucket === 'week' ? 'week' : 'day';
    const windowDays = parsePositiveIntOrDefault(query.window_days, 30);
    const scopedQuery = { ...query };
    if (!scopedQuery.from && !scopedQuery.to) {
      scopedQuery.from = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    }

    const { whereSql, params } = buildTaskRunsWhereClause(scopedQuery, 'tr');
    const rows = reliabilityRepository.fetchFailureModeTrendRows({ whereSql, params });

    const buckets = new Map();
    const byRunner = new Map();

    function upsertBucket(map, key, startDate) {
      if (!map.has(key)) {
        const base = createFailureModeTrendBucket(startDate);
        base.bucket_end = addBucketSpan(startDate, bucket).toISOString();
        map.set(key, base);
      }
      return map.get(key);
    }

    for (const row of rows) {
      const start = floorToBucketStart(row.started_at, bucket);
      if (!start) continue;
      const key = start.toISOString();
      const runnerName = row.runner || 'unknown';

      const globalBucket = upsertBucket(buckets, key, start);
      if (!byRunner.has(runnerName)) byRunner.set(runnerName, new Map());
      const runnerBucket = upsertBucket(byRunner.get(runnerName), key, start);

      for (const target of [globalBucket, runnerBucket]) {
        target.task_runs += 1;
        if (row.canonical_outcome_label) target.with_canonical_outcome += 1;
        if (row.canonical_failure_mode) {
          target.with_failure_mode += 1;
          const prev = target.mode_counts.get(row.canonical_failure_mode) || 0;
          target.mode_counts.set(row.canonical_failure_mode, prev + 1);
        }
      }
    }

    const series = [...buckets.values()]
      .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start))
      .map(finalizeFailureModeTrendBucket);

    const by_runner = {};
    for (const [runner, runnerBuckets] of byRunner.entries()) {
      by_runner[runner] = [...runnerBuckets.values()]
        .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start))
        .map(finalizeFailureModeTrendBucket);
    }

    const insufficient_evidence = series
      .filter((row) => row.with_canonical_outcome > 0 && row.with_canonical_outcome < KPI_MIN_CANONICAL_SAMPLE)
      .map((row) => ({
        bucket_start: row.bucket_start,
        reason: `with_canonical_outcome < ${KPI_MIN_CANONICAL_SAMPLE}`
      }))
      .slice(-6);

    return {
      bucket,
      window_days: windowDays,
      from: scopedQuery.from || null,
      to: scopedQuery.to || null,
      thresholds: {
        min_canonical_sample: KPI_MIN_CANONICAL_SAMPLE
      },
      series,
      by_runner,
      insufficient_evidence
    };
  }

  function fetchReliabilityRows(query = {}) {
    const { whereSql, params } = buildTaskRunsWhereClause(query, 'tr');
    return reliabilityRepository.fetchReliabilityRows({ whereSql, params });
  }

  function summarizeReliabilityKpis(rows) {
    const totalRuns = rows.length;
    const withCanonical = rows.filter(r => !!r.canonical_outcome_label);
    const successfulRuns = withCanonical.filter(r => r.canonical_outcome_label === 'success');
    const runsWithKnownCost = rows.filter(r => Number(r.estimated_cost_known) === 1);
    const successfulRunsWithKnownCost = successfulRuns.filter(r => Number(r.estimated_cost_known) === 1);
    const unsafeSuccessRuns = withCanonical.filter(r => r.canonical_outcome_label === 'unsafe_success');
    const retryRuns = rows.filter(r => (r.retry_count || 0) > 0);
    const firstPassSuccessRuns = successfulRuns.filter(r => (r.retry_count || 0) === 0);
    const interventionRuns = withCanonical.filter(r => Number(r.canonical_requires_human_intervention) === 1);

    const totalCost = runsWithKnownCost.reduce((sum, r) => sum + (r.estimated_cost || 0), 0);
    const successfulCost = successfulRunsWithKnownCost.reduce((sum, r) => sum + (r.estimated_cost || 0), 0);

    const durations = rows
      .map(r => r.total_duration_ms)
      .filter(v => typeof v === 'number' && Number.isFinite(v));

    const tokenInputTotal = rows.reduce((sum, r) => sum + (r.token_input || 0), 0);
    const tokenOutputTotal = rows.reduce((sum, r) => sum + (r.token_output || 0), 0);
    const tokenCacheCreationTotal = rows.reduce((sum, r) => sum + (r.token_cache_creation || 0), 0);
    const tokenCacheReadTotal = rows.reduce((sum, r) => sum + (r.token_cache_read || 0), 0);

    return {
      counts: {
        task_runs: totalRuns,
        with_canonical_outcome: withCanonical.length,
        successful_runs: successfulRuns.length,
        successful_runs_with_known_cost: successfulRunsWithKnownCost.length,
        runs_with_known_cost: runsWithKnownCost.length,
        unsafe_success_runs: unsafeSuccessRuns.length,
        retry_runs: retryRuns.length,
        first_pass_success_runs: firstPassSuccessRuns.length,
        intervention_runs: interventionRuns.length
      },
      rates: {
        success_rate: ratioOrNull(successfulRuns.length, withCanonical.length),
        unsafe_success_rate: ratioOrNull(unsafeSuccessRuns.length, withCanonical.length),
        first_pass_rate: ratioOrNull(firstPassSuccessRuns.length, withCanonical.length),
        retry_rate: ratioOrNull(retryRuns.length, totalRuns),
        intervention_rate: ratioOrNull(interventionRuns.length, withCanonical.length)
      },
      cost: {
        total_estimated_cost: +totalCost.toFixed(6),
        successful_estimated_cost: +successfulCost.toFixed(6),
        cost_per_success: ratioOrNull(successfulCost, successfulRunsWithKnownCost.length)
      },
      duration_ms: {
        p50: durations.length ? Math.round(quantile(durations, 0.5)) : null,
        p95: durations.length ? Math.round(quantile(durations, 0.95)) : null
      },
      tokens: {
        input_total: tokenInputTotal,
        output_total: tokenOutputTotal,
        cache_creation_total: tokenCacheCreationTotal,
        cache_read_total: tokenCacheReadTotal,
        input_per_run: ratioOrNull(tokenInputTotal, totalRuns),
        output_per_run: ratioOrNull(tokenOutputTotal, totalRuns)
      }
    };
  }

  function deriveKpiAnomalies(kpiSummary, targets = {}) {
    const counts = kpiSummary?.counts || {};
    const rates = kpiSummary?.rates || {};
    const cost = kpiSummary?.cost || {};
    const withCanonical = Number(counts.with_canonical_outcome || 0);
    const successWithKnownCostCount = Number(counts.successful_runs_with_known_cost || 0);
    const anomalies = [];

    if (withCanonical === 0) {
      anomalies.push({
        code: 'no_canonical_outcomes',
        severity: 'high',
        message: 'No canonical outcomes. Outcome-dependent rates are not interpretable.'
      });
    }

    if (withCanonical > 0 && withCanonical < KPI_MIN_CANONICAL_SAMPLE) {
      anomalies.push({
        code: 'low_sample_size',
        severity: 'medium',
        message: `Only ${withCanonical} canonical outcomes. KPI stability is limited (recommended >= ${KPI_MIN_CANONICAL_SAMPLE}).`
      });
    }

    if (successWithKnownCostCount > 0 && successWithKnownCostCount < KPI_MIN_SUCCESS_SAMPLE_FOR_COST) {
      anomalies.push({
        code: 'unstable_cost_per_success',
        severity: 'medium',
        message: `Only ${successWithKnownCostCount} successful runs with known cost. Cost-per-success is unstable (recommended >= ${KPI_MIN_SUCCESS_SAMPLE_FOR_COST}).`
      });
    }

    const metricValues = {
      success_rate: rates.success_rate,
      first_pass_rate: rates.first_pass_rate,
      retry_rate: rates.retry_rate,
      unsafe_success_rate: rates.unsafe_success_rate,
      intervention_rate: rates.intervention_rate,
      cost_per_success: cost.cost_per_success
    };
    for (const [metric, rule] of Object.entries(targets || {})) {
      const value = metricValues[metric];
      if (value == null) continue;
      if (rule.min != null && value < rule.min) {
        anomalies.push({
          code: `below_target_${metric}`,
          severity: rule.severity || 'medium',
          message: `${metric} is ${formatKpiValue(metric, value)}, below target ${formatKpiValue(metric, rule.min)}.`
        });
      }
      if (rule.max != null && value > rule.max) {
        anomalies.push({
          code: `above_target_${metric}`,
          severity: rule.severity || 'medium',
          message: `${metric} is ${formatKpiValue(metric, value)}, above target ${formatKpiValue(metric, rule.max)}.`
        });
      }
    }

    return anomalies;
  }

  function buildReliabilityReviewMarkdown(review) {
    const period = review.period || {};
    const kpis = review.kpis || {};
    const rates = kpis.rates || {};
    const cost = kpis.cost || {};
    const counts = kpis.counts || {};
    const lines = [
      '# Reliability Review',
      '',
      `- Generated at: ${review.generated_at}`,
      `- From: ${period.from || '—'}`,
      `- To: ${period.to || '—'}`,
      '',
      '## KPI Snapshot',
      '',
      `- Task runs: ${counts.task_runs ?? 0}`,
      `- Canonical outcomes: ${counts.with_canonical_outcome ?? 0}`,
      `- Success rate: ${formatKpiValue('success_rate', rates.success_rate)}`,
      `- Retry rate: ${formatKpiValue('retry_rate', rates.retry_rate)}`,
      `- Intervention rate: ${formatKpiValue('intervention_rate', rates.intervention_rate)}`,
      `- Cost per success: ${formatKpiValue('cost_per_success', cost.cost_per_success)}`,
      ''
    ];

    lines.push('## Signals', '');
    const anomalies = review.anomalies || [];
    if (!anomalies.length) lines.push('- No KPI anomalies.');
    else anomalies.slice(0, 8).forEach((a) => lines.push(`- [${a.severity}] ${a.code}: ${a.message}`));
    lines.push('');

    lines.push('## Failure Modes', '');
    const latestFailureBucket = review.failure_modes?.latest_bucket || null;
    if (!latestFailureBucket || !latestFailureBucket.by_mode?.length) {
      lines.push('- No failure mode data in this period.');
    } else {
      latestFailureBucket.by_mode.slice(0, 5).forEach((row) => {
        lines.push(`- ${row.failure_mode}: ${row.count} (${formatKpiValue('retry_rate', row.failure_mode_share)})`);
      });
    }
    lines.push('');

    lines.push('## Backlog', '');
    lines.push(`- Runs without canonical outcome: ${review.labeling_backlog?.no_canonical_outcome_runs ?? 0}`);
    lines.push('');

    lines.push('## Top Failing Runs', '');
    const failingRuns = review.top_failing_runs || [];
    if (!failingRuns.length) {
      lines.push('- No failing runs in this period.');
    } else {
      for (const run of failingRuns) {
        lines.push(`- #${run.id} ${run.task_key} | ${run.canonical_outcome_label} | errors=${run.error_count} retries=${run.retry_count} cost=${formatKpiValue('cost_per_success', run.estimated_cost)}`);
      }
    }

    return lines.join('\n').trim();
  }

  function getLatestReviewAcknowledgement({ periodFrom, periodTo, runner }) {
    if (!periodFrom || !periodTo) return null;
    const normalizedRunner = normalizeOptionalString(runner);
    return reviewAcknowledgementsRepository.getLatest({
      periodFrom,
      periodTo,
      runner: normalizedRunner || null
    });
  }

  function buildReliabilityReviewData(query = {}) {
    const scopedQuery = { ...query };
    if (scopedQuery.week_of && !scopedQuery.from && !scopedQuery.to) {
      const weekDate = new Date(scopedQuery.week_of);
      if (!Number.isNaN(weekDate.getTime())) {
        const weekStart = floorToBucketStart(weekDate.toISOString(), 'week');
        const weekEnd = addBucketSpan(weekStart, 'week');
        scopedQuery.from = weekStart.toISOString();
        scopedQuery.to = weekEnd.toISOString();
      }
    }
    if (!scopedQuery.from && !scopedQuery.to) {
      scopedQuery.from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      scopedQuery.to = new Date().toISOString();
    } else if (scopedQuery.from && !scopedQuery.to) {
      scopedQuery.to = new Date().toISOString();
    }

    const rows = fetchReliabilityRows(scopedQuery);
    const kpis = summarizeReliabilityKpis(rows);
    const targets = getConfiguredKpiTargets();
    const anomalies = deriveKpiAnomalies(kpis, targets);
    const trendQuery = {
      ...scopedQuery,
      bucket: scopedQuery.bucket === 'day' ? 'day' : 'week'
    };
    const trends = buildReliabilityTrendsData(trendQuery);
    const trendInsights = (() => {
      const series = trends.series || [];
      if (series.length < 2) return null;
      const previous = series[series.length - 2];
      const current = series[series.length - 1];
      const metricDelta = (key) => {
        if (previous[key] == null || current[key] == null) return null;
        return +(current[key] - previous[key]).toFixed(6);
      };
      return {
        previous_bucket_start: previous.bucket_start,
        current_bucket_start: current.bucket_start,
        success_rate_delta: metricDelta('success_rate'),
        retry_rate_delta: metricDelta('retry_rate'),
        cost_per_success_delta: metricDelta('cost_per_success')
      };
    })();
    const failureModes = buildFailureModeTrendsData(trendQuery);

    const backlogWhere = buildTaskRunsWhereClause({
      ...scopedQuery,
      has_canonical_outcome: 'false'
    }, 'tr');
    const backlogCount = reliabilityRepository.countLabelingBacklog(backlogWhere);

    const topFailWhere = buildTaskRunsWhereClause(scopedQuery, 'tr');
    const topFailingRuns = reliabilityRepository.listTopFailingRuns({
      whereSql: topFailWhere.whereSql,
      params: topFailWhere.params,
      limit: 5
    });

    const review = {
      generated_at: new Date().toISOString(),
      period: {
        from: scopedQuery.from || null,
        to: scopedQuery.to || null,
        bucket: trendQuery.bucket
      },
      filters: {
        runner: scopedQuery.runner || null,
        source: scopedQuery.source || null,
        status: scopedQuery.status || null
      },
      thresholds: {
        min_canonical_sample: KPI_MIN_CANONICAL_SAMPLE,
        min_success_sample_for_cost: KPI_MIN_SUCCESS_SAMPLE_FOR_COST,
        targets
      },
      kpis,
      anomalies,
      trends: {
        latest_bucket: (trends.series || []).length ? trends.series[trends.series.length - 1] : null,
        delta_from_previous_bucket: trendInsights
      },
      failure_modes: {
        latest_bucket: (failureModes.series || []).length ? failureModes.series[failureModes.series.length - 1] : null,
        insufficient_evidence: failureModes.insufficient_evidence || []
      },
      labeling_backlog: {
        no_canonical_outcome_runs: backlogCount || 0
      },
      top_failing_runs: topFailingRuns
    };

    const latestAck = getLatestReviewAcknowledgement({
      periodFrom: review.period.from,
      periodTo: review.period.to,
      runner: review.filters.runner
    });

    review.acknowledgement = latestAck
      ? {
        acknowledged: true,
        id: latestAck.id,
        reviewer: latestAck.reviewer,
        acknowledged_at: latestAck.acknowledged_at,
        notes: latestAck.notes || null
      }
      : { acknowledged: false };

    review.markdown = buildReliabilityReviewMarkdown(review);
    return review;
  }

  function getKpiComparePeriods(query = {}) {
    const periodDays = parsePositiveIntOrDefault(query.period_days, 7);
    const now = new Date();
    const periodMs = periodDays * 24 * 60 * 60 * 1000;

    const aFrom = query.period_a_from || new Date(now.getTime() - periodMs).toISOString();
    const aTo = query.period_a_to || now.toISOString();
    const bFrom = query.period_b_from || new Date(new Date(aFrom).getTime() - periodMs).toISOString();
    const bTo = query.period_b_to || new Date(aFrom).toISOString();

    return {
      period_days: periodDays,
      period_a: { from: aFrom, to: aTo },
      period_b: { from: bFrom, to: bTo }
    };
  }

  function buildKpiCompareDeltas(periodA, periodB) {
    const a = periodA || {};
    const b = periodB || {};
    return {
      counts: {
        task_runs: deltaOrNull(a.counts?.task_runs, b.counts?.task_runs),
        with_canonical_outcome: deltaOrNull(a.counts?.with_canonical_outcome, b.counts?.with_canonical_outcome),
        successful_runs: deltaOrNull(a.counts?.successful_runs, b.counts?.successful_runs)
      },
      rates: {
        success_rate: deltaOrNull(a.rates?.success_rate, b.rates?.success_rate),
        first_pass_rate: deltaOrNull(a.rates?.first_pass_rate, b.rates?.first_pass_rate),
        retry_rate: deltaOrNull(a.rates?.retry_rate, b.rates?.retry_rate),
        intervention_rate: deltaOrNull(a.rates?.intervention_rate, b.rates?.intervention_rate),
        unsafe_success_rate: deltaOrNull(a.rates?.unsafe_success_rate, b.rates?.unsafe_success_rate)
      },
      cost: {
        total_estimated_cost: deltaOrNull(a.cost?.total_estimated_cost, b.cost?.total_estimated_cost),
        cost_per_success: deltaOrNull(a.cost?.cost_per_success, b.cost?.cost_per_success)
      },
      duration_ms: {
        p50: deltaOrNull(a.duration_ms?.p50, b.duration_ms?.p50),
        p95: deltaOrNull(a.duration_ms?.p95, b.duration_ms?.p95)
      }
    };
  }

  return {
    getConfiguredKpiTargets,
    buildReliabilityTrendsData,
    buildFailureModeTrendsData,
    fetchReliabilityRows,
    summarizeReliabilityKpis,
    deriveKpiAnomalies,
    buildReliabilityReviewData,
    getKpiComparePeriods,
    buildKpiCompareDeltas
  };
}

module.exports = {
  createReliabilityDomain
};
