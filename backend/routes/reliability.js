const {
  parseOrRespond,
  reliabilityCommonQuerySchema,
  reviewAcknowledgeBodySchema,
  reviewAcknowledgementsQuerySchema
} = require('./validation');

function registerReliabilityRoutes(app, deps) {
  const {
    reviewAcknowledgementsRepository,
    KPI_MIN_CANONICAL_SAMPLE,
    KPI_MIN_SUCCESS_SAMPLE_FOR_COST,
    getConfiguredKpiTargets,
    fetchReliabilityRows,
    summarizeReliabilityKpis,
    deriveKpiAnomalies,
    getKpiComparePeriods,
    buildKpiCompareDeltas,
    buildReliabilityTrendsData,
    buildFailureModeTrendsData,
    buildReliabilityReviewData,
    normalizeIsoTimestampOrNull,
    normalizeOptionalString
  } = deps;

  app.get('/api/reliability/kpis', (req, res) => {
    try {
      const query = parseOrRespond(reliabilityCommonQuerySchema, req.query, res);
      if (!query) return;
      const rows = fetchReliabilityRows(query);
      const targets = getConfiguredKpiTargets();
      const kpis = summarizeReliabilityKpis(rows);
      res.json({
        ...kpis,
        thresholds: {
          min_canonical_sample: KPI_MIN_CANONICAL_SAMPLE,
          min_success_sample_for_cost: KPI_MIN_SUCCESS_SAMPLE_FOR_COST,
          targets
        },
        anomalies: deriveKpiAnomalies(kpis, targets)
      });
    } catch (error) {
      console.error('Reliability KPI error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/reliability/kpi-definitions', (_req, res) => {
    res.json({
      version: '1.0',
      thresholds: {
        min_canonical_sample: KPI_MIN_CANONICAL_SAMPLE,
        min_success_sample_for_cost: KPI_MIN_SUCCESS_SAMPLE_FOR_COST
      },
      metrics: {
        success_rate: {
          formula: 'successful_runs / with_canonical_outcome',
          numerator: 'count(outcome_label = success, canonical only)',
          denominator: 'count(canonical outcomes)',
          null_when: 'with_canonical_outcome = 0'
        },
        first_pass_rate: {
          formula: 'first_pass_success_runs / with_canonical_outcome',
          numerator: 'count(success with retry_count = 0, canonical only)',
          denominator: 'count(canonical outcomes)',
          null_when: 'with_canonical_outcome = 0'
        },
        retry_rate: {
          formula: 'retry_runs / task_runs',
          numerator: 'count(task_runs with retry_count > 0)',
          denominator: 'count(task_runs)',
          null_when: 'task_runs = 0'
        },
        intervention_rate: {
          formula: 'intervention_runs / with_canonical_outcome',
          numerator: 'count(canonical outcomes with requires_human_intervention = 1)',
          denominator: 'count(canonical outcomes)',
          null_when: 'with_canonical_outcome = 0'
        },
        cost_per_success: {
          formula: 'successful_estimated_cost / successful_runs_with_known_cost',
          numerator: 'sum(estimated_cost for canonical outcome_label = success and estimated_cost_known = 1)',
          denominator: 'count(successful canonical outcomes with estimated_cost_known = 1)',
          null_when: 'successful_runs_with_known_cost = 0'
        }
      }
    });
  });

  app.get('/api/reliability/kpis/by-runner', (req, res) => {
    try {
      const query = parseOrRespond(reliabilityCommonQuerySchema, req.query, res);
      if (!query) return;
      const rows = fetchReliabilityRows(query);
      const targets = getConfiguredKpiTargets();

      const byRunnerMap = new Map();
      for (const row of rows) {
        const runner = row.runner || 'unknown';
        if (!byRunnerMap.has(runner)) byRunnerMap.set(runner, []);
        byRunnerMap.get(runner).push(row);
      }

      const by_runner = [...byRunnerMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([runner, runnerRows]) => {
          const kpis = summarizeReliabilityKpis(runnerRows);
          return {
            runner,
            ...kpis,
            anomalies: deriveKpiAnomalies(kpis, targets)
          };
        });

      res.json({
        total_runners: by_runner.length,
        thresholds: {
          min_canonical_sample: KPI_MIN_CANONICAL_SAMPLE,
          min_success_sample_for_cost: KPI_MIN_SUCCESS_SAMPLE_FOR_COST,
          targets
        },
        by_runner
      });
    } catch (error) {
      console.error('Reliability KPI by-runner error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/reliability/kpis/compare', (req, res) => {
    try {
      const query = parseOrRespond(reliabilityCommonQuerySchema, req.query, res);
      if (!query) return;
      const periods = getKpiComparePeriods(query);
      const targets = getConfiguredKpiTargets();

      const commonFilters = { ...query };
      delete commonFilters.period_days;
      delete commonFilters.period_a_from;
      delete commonFilters.period_a_to;
      delete commonFilters.period_b_from;
      delete commonFilters.period_b_to;

      const periodAQuery = {
        ...commonFilters,
        from: periods.period_a.from,
        to: periods.period_a.to
      };
      const periodBQuery = {
        ...commonFilters,
        from: periods.period_b.from,
        to: periods.period_b.to
      };

      const periodAKpis = summarizeReliabilityKpis(fetchReliabilityRows(periodAQuery));
      const periodBKpis = summarizeReliabilityKpis(fetchReliabilityRows(periodBQuery));

      res.json({
        period_days: periods.period_days,
        thresholds: {
          min_canonical_sample: KPI_MIN_CANONICAL_SAMPLE,
          min_success_sample_for_cost: KPI_MIN_SUCCESS_SAMPLE_FOR_COST,
          targets
        },
        period_a: {
          ...periods.period_a,
          ...periodAKpis,
          anomalies: deriveKpiAnomalies(periodAKpis, targets)
        },
        period_b: {
          ...periods.period_b,
          ...periodBKpis,
          anomalies: deriveKpiAnomalies(periodBKpis, targets)
        },
        deltas: buildKpiCompareDeltas(periodAKpis, periodBKpis)
      });
    } catch (error) {
      console.error('Reliability KPI compare error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/reliability/trends', (req, res) => {
    try {
      const query = parseOrRespond(reliabilityCommonQuerySchema, req.query, res);
      if (!query) return;
      res.json(buildReliabilityTrendsData(query));
    } catch (error) {
      console.error('Reliability trends error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/reliability/trends/insights', (req, res) => {
    try {
      const query = parseOrRespond(reliabilityCommonQuerySchema, req.query, res);
      if (!query) return;
      const trendData = buildReliabilityTrendsData(query);
      const series = trendData.series || [];
      const deltas = [];
      const thresholds = {
        min_canonical_sample: KPI_MIN_CANONICAL_SAMPLE,
        min_success_sample_for_cost: KPI_MIN_SUCCESS_SAMPLE_FOR_COST,
        significant_abs_delta: {
          success_rate: 0.1,
          retry_rate: 0.1
        },
        significant_relative_delta: {
          cost_per_success: 0.25
        }
      };

      const metricSpecs = [
        { key: 'success_rate', direction: 'higher_better', significantAbs: thresholds.significant_abs_delta.success_rate },
        { key: 'retry_rate', direction: 'lower_better', significantAbs: thresholds.significant_abs_delta.retry_rate },
        { key: 'cost_per_success', direction: 'lower_better', significantRelative: thresholds.significant_relative_delta.cost_per_success }
      ];

      function bucketHasEnoughSample(bucketRow, metricKey) {
        if (!bucketRow) return false;
        if (metricKey === 'cost_per_success') return (bucketRow.successful_runs_with_known_cost || 0) >= KPI_MIN_SUCCESS_SAMPLE_FOR_COST;
        return (bucketRow.with_canonical_outcome || 0) >= KPI_MIN_CANONICAL_SAMPLE;
      }

      for (const metric of metricSpecs) {
        for (let i = 1; i < series.length; i++) {
          const previous = series[i - 1];
          const current = series[i];
          const previousValue = previous?.[metric.key];
          const currentValue = current?.[metric.key];
          if (previousValue == null || currentValue == null) continue;

          const absDelta = +(currentValue - previousValue).toFixed(6);
          const relativeDelta = previousValue === 0 ? null : +((currentValue - previousValue) / Math.abs(previousValue)).toFixed(6);
          const insufficientSample = !bucketHasEnoughSample(previous, metric.key) || !bucketHasEnoughSample(current, metric.key);

          let significant = false;
          if (metric.significantAbs != null) {
            significant = Math.abs(absDelta) >= metric.significantAbs;
          } else if (metric.significantRelative != null && relativeDelta != null) {
            significant = Math.abs(relativeDelta) >= metric.significantRelative;
          }

          const improved = metric.direction === 'higher_better' ? absDelta > 0 : absDelta < 0;

          deltas.push({
            metric: metric.key,
            previous_bucket_start: previous.bucket_start,
            current_bucket_start: current.bucket_start,
            previous_value: previousValue,
            current_value: currentValue,
            abs_delta: absDelta,
            relative_delta: relativeDelta,
            significant,
            insufficient_sample: insufficientSample,
            direction: improved ? 'improving' : 'degrading'
          });
        }
      }

      const comparable = deltas.filter(d => d.significant && !d.insufficient_sample);
      const improving = comparable
        .filter(d => d.direction === 'improving')
        .sort((a, b) => Math.abs(b.abs_delta) - Math.abs(a.abs_delta))
        .slice(0, 3);
      const degrading = comparable
        .filter(d => d.direction === 'degrading')
        .sort((a, b) => Math.abs(b.abs_delta) - Math.abs(a.abs_delta))
        .slice(0, 3);

      const insufficientEvidenceMap = new Map();
      for (const d of deltas.filter(item => item.insufficient_sample)) {
        const reason = d.metric === 'cost_per_success'
          ? `successful_runs_with_known_cost < ${KPI_MIN_SUCCESS_SAMPLE_FOR_COST}`
          : `with_canonical_outcome < ${KPI_MIN_CANONICAL_SAMPLE}`;
        const key = `${d.metric}::${reason}`;
        const existing = insufficientEvidenceMap.get(key);
        if (!existing || existing.bucket_start < d.current_bucket_start) {
          insufficientEvidenceMap.set(key, {
            metric: d.metric,
            bucket_start: d.current_bucket_start,
            reason
          });
        }
      }
      const insufficient_evidence = [...insufficientEvidenceMap.values()]
        .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start))
        .slice(-6);

      res.json({
        ...trendData,
        thresholds,
        latest_bucket_start: series.length ? series[series.length - 1].bucket_start : null,
        insights: {
          improving,
          degrading,
          insufficient_evidence
        },
        deltas
      });
    } catch (error) {
      console.error('Reliability trend insights error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/reliability/trends/failure-modes', (req, res) => {
    try {
      const query = parseOrRespond(reliabilityCommonQuerySchema, req.query, res);
      if (!query) return;
      res.json(buildFailureModeTrendsData(query));
    } catch (error) {
      console.error('Reliability failure-mode trends error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/reliability/review', (req, res) => {
    try {
      const query = parseOrRespond(reliabilityCommonQuerySchema, req.query, res);
      if (!query) return;
      res.json(buildReliabilityReviewData(query));
    } catch (error) {
      console.error('Reliability review error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/reliability/review/acknowledge', (req, res) => {
    try {
      const body = parseOrRespond(reviewAcknowledgeBodySchema, req.body, res);
      if (!body) return;
      const periodFrom = normalizeIsoTimestampOrNull(body.period_from);
      const periodTo = normalizeIsoTimestampOrNull(body.period_to);
      const reviewer = normalizeOptionalString(body.reviewer);
      const notes = normalizeOptionalString(body.notes);
      const runner = normalizeOptionalString(body.runner);

      if (!periodFrom || !periodTo) {
        return res.status(400).json({ error: 'period_from and period_to are required ISO timestamps' });
      }
      if (new Date(periodFrom).getTime() >= new Date(periodTo).getTime()) {
        return res.status(400).json({ error: 'period_from must be earlier than period_to' });
      }
      if (!reviewer) {
        return res.status(400).json({ error: 'reviewer is required' });
      }

      const acknowledgedAt = new Date().toISOString();
      const result = reviewAcknowledgementsRepository.create({
        periodFrom,
        periodTo,
        runner,
        reviewer,
        acknowledgedAt,
        notes
      });

      res.json({
        success: true,
        acknowledgement: {
          id: result.lastInsertRowid,
          period_from: periodFrom,
          period_to: periodTo,
          runner: runner || null,
          reviewer,
          acknowledged_at: acknowledgedAt,
          notes: notes || null
        }
      });
    } catch (error) {
      console.error('Reliability review acknowledge error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/reliability/review/acknowledgements', (req, res) => {
    try {
      const query = parseOrRespond(reviewAcknowledgementsQuerySchema, req.query, res);
      if (!query) return;
      const periodFrom = normalizeIsoTimestampOrNull(query.period_from);
      const periodTo = normalizeIsoTimestampOrNull(query.period_to);
      const runner = normalizeOptionalString(query.runner);
      const limit = query.limit;

      const rows = query.runner === ''
        ? reviewAcknowledgementsRepository.listNullRunner({ periodFrom, periodTo, limit })
        : reviewAcknowledgementsRepository.list({ periodFrom, periodTo, runner, limit });

      res.json({ acknowledgements: rows, total: rows.length });
    } catch (error) {
      console.error('Reliability review acknowledgements error:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = {
  registerReliabilityRoutes
};
