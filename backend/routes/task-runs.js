function registerTaskRunRoutes(app, deps) {
  const {
    taskRunsRepository,
    outcomesRepository,
    parseJSONSafe,
    backfillAllTaskRuns,
    buildTaskRunsWhereClause,
    getTaskRunById,
    getStoredTaskRunAfterActionReport,
    isStoredTaskRunReportFresh,
    buildTaskRunAfterActionReport,
    upsertStoredTaskRunAfterActionReport,
    validateOutcomePayload,
    insertOutcomeForTaskRun
  } = deps;

  app.post('/api/task-runs/derive', (req, res) => {
    try {
      const derived = backfillAllTaskRuns();
      res.json({ success: true, derived });
    } catch (error) {
      console.error('Derive task runs error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/task-runs', (req, res) => {
    try {
      const {
        page = 1,
        pageSize = 50,
        sortKey = 'started_at',
        sortDir = 'desc'
      } = req.query;

      const { whereSql, params: filterParams } = buildTaskRunsWhereClause(req.query, 'task_runs');
      const params = [...filterParams];
      const total = taskRunsRepository.countByWhere({ whereSql, params });

      const allowedSortKeys = ['started_at', 'ended_at', 'updated_at', 'total_events', 'total_duration_ms', 'estimated_cost'];
      const safeSortKey = allowedSortKeys.includes(sortKey) ? sortKey : 'started_at';
      const safeSortDir = sortDir === 'asc' ? 'ASC' : 'DESC';

      const limit = parseInt(pageSize, 10);
      const offset = (parseInt(page, 10) - 1) * limit;

      const taskRuns = taskRunsRepository.listByWhere({
        whereSql,
        params,
        sortKey: safeSortKey,
        sortDir: safeSortDir,
        limit,
        offset
      }).map(row => ({
        ...row,
        metadata: parseJSONSafe(row.metadata, null)
      }));

      res.json({
        taskRuns,
        total,
        page: parseInt(page, 10),
        pageSize: limit,
        totalPages: Math.ceil(total / limit)
      });
    } catch (error) {
      console.error('List task runs error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/task-runs/outcome-summary', (req, res) => {
    try {
      const { whereSql, params } = buildTaskRunsWhereClause(req.query, 'tr');

      const totals = taskRunsRepository.getOutcomeSummaryTotals({ whereSql, params });
      const byOutcomeLabel = taskRunsRepository.listOutcomeSummaryByField({ whereSql, params, field: 'outcome_label' });
      const byFailureMode = taskRunsRepository.listOutcomeSummaryByField({ whereSql, params, field: 'failure_mode' });
      const byFailureSubtype = taskRunsRepository.listOutcomeSummaryByField({ whereSql, params, field: 'failure_subtype' });
      const byEvaluationType = taskRunsRepository.listOutcomeSummaryByField({ whereSql, params, field: 'evaluation_type' });

      res.json({
        totals: {
          task_runs: totals?.task_runs || 0,
          with_canonical_outcome: totals?.with_canonical_outcome || 0,
          no_canonical_outcome: totals?.no_canonical_outcome || 0,
          requires_human_intervention: totals?.requires_human_intervention || 0
        },
        by_outcome_label: byOutcomeLabel,
        by_failure_mode: byFailureMode,
        by_failure_subtype: byFailureSubtype,
        by_evaluation_type: byEvaluationType
      });
    } catch (error) {
      console.error('Task run outcome summary error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/task-runs/:id', (req, res) => {
    try {
      const taskRun = getTaskRunById(req.params.id);
      if (!taskRun) {
        return res.status(404).json({ error: 'Task run not found' });
      }

      const eventRows = taskRunsRepository.listEventDataForTaskRun(req.params.id);

      const events = eventRows.map(row => ({ __key: row.key, ...parseJSONSafe(row.data, {}) }));
      const outcomes = outcomesRepository.listOutcomesForTaskRun(req.params.id).map(row => ({
        ...row,
        requires_human_intervention: !!row.requires_human_intervention,
        is_canonical: !!row.is_canonical,
        evidence: parseJSONSafe(row.evidence, null)
      }));

      res.json({
        ...taskRun,
        metadata: parseJSONSafe(taskRun.metadata, null),
        events,
        outcomes
      });
    } catch (error) {
      console.error('Get task run error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/task-runs/:id/after-action-report', (req, res) => {
    try {
      const taskRunId = req.params.id;
      const taskRun = getTaskRunById(taskRunId);
      if (!taskRun) {
        return res.status(404).json({ error: 'Task run not found' });
      }

      const reportContext = {
        canonicalOutcomeId: outcomesRepository.getCanonicalOutcomeIdForTaskRun(taskRunId),
        taskRunUpdatedAt: taskRun.updated_at || null
      };

      const storedOnly = String(req.query?.stored || '').toLowerCase() === 'true';
      const stored = getStoredTaskRunAfterActionReport(taskRunId);
      const storedFresh = isStoredTaskRunReportFresh(stored, reportContext);
      if (storedFresh) {
        return res.json({
          ...stored.report,
          cache: {
            source: 'db',
            fresh: true
          }
        });
      }

      if (storedOnly) {
        if (stored) {
          return res.json({
            ...stored.report,
            cache: {
              source: 'db',
              fresh: false,
              stale: true
            }
          });
        }
        return res.json({
          missing: true,
          cache: {
            source: 'none',
            fresh: false
          }
        });
      }

      const report = buildTaskRunAfterActionReport(taskRunId);
      if (!report) {
        return res.status(404).json({ error: 'Task run not found' });
      }
      upsertStoredTaskRunAfterActionReport(taskRunId, report, reportContext);
      res.json({
        ...report,
        cache: {
          source: 'generated',
          fresh: false
        }
      });
    } catch (error) {
      console.error('Task run after-action report error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/task-runs/:id/outcomes', (req, res) => {
    try {
      const taskRun = getTaskRunById(req.params.id);
      if (!taskRun) {
        return res.status(404).json({ error: 'Task run not found' });
      }

      const validation = validateOutcomePayload(req.body);
      if (!validation.ok) {
        return res.status(validation.status || 400).json(validation);
      }

      const result = insertOutcomeForTaskRun(req.params.id, validation.value);
      res.json({ success: true, outcomeId: result.lastInsertRowid });
    } catch (error) {
      console.error('Create outcome error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/task-runs/outcomes/batch', (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Request body must be a JSON object' });
      }

      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items must be a non-empty array' });
      }

      const results = [];
      let successCount = 0;
      let failureCount = 0;

      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          results.push({ index, success: false, error: 'Item must be a JSON object' });
          failureCount++;
          continue;
        }

        const taskRunId = item.task_run_id;
        if (!taskRunId) {
          results.push({ index, success: false, error: 'task_run_id is required' });
          failureCount++;
          continue;
        }

        const taskRun = getTaskRunById(taskRunId);
        if (!taskRun) {
          results.push({ index, task_run_id: taskRunId, success: false, error: 'Task run not found' });
          failureCount++;
          continue;
        }

        const payload = { ...item };
        delete payload.task_run_id;
        const validation = validateOutcomePayload(payload);
        if (!validation.ok) {
          results.push({
            index,
            task_run_id: taskRunId,
            success: false,
            error: validation.error,
            details: validation
          });
          failureCount++;
          continue;
        }

        try {
          const insertResult = insertOutcomeForTaskRun(taskRunId, validation.value);
          results.push({
            index,
            task_run_id: taskRunId,
            success: true,
            outcomeId: insertResult.lastInsertRowid
          });
          successCount++;
        } catch (err) {
          results.push({
            index,
            task_run_id: taskRunId,
            success: false,
            error: err.message || 'Failed to insert outcome'
          });
          failureCount++;
        }
      }

      const status = failureCount === 0 ? 'ok' : (successCount === 0 ? 'failed' : 'partial');
      res.json({
        success: failureCount === 0,
        status,
        total: items.length,
        success_count: successCount,
        failure_count: failureCount,
        results
      });
    } catch (error) {
      console.error('Batch create outcomes error:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = {
  registerTaskRunRoutes
};
