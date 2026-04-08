function registerTaskRunRoutes(app, deps) {
  const {
    db,
    parseJSONSafe,
    backfillAllTaskRuns,
    buildTaskRunsWhereClause,
    getTaskRunById,
    getTaskRunCanonicalOutcomeId,
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
      let sql = `SELECT * FROM task_runs WHERE ${whereSql}`;
      const params = [...filterParams];

      const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as count');
      const total = db.prepare(countSql).get(...params).count;

      const allowedSortKeys = ['started_at', 'ended_at', 'updated_at', 'total_events', 'total_duration_ms', 'estimated_cost'];
      const safeSortKey = allowedSortKeys.includes(sortKey) ? sortKey : 'started_at';
      const safeSortDir = sortDir === 'asc' ? 'ASC' : 'DESC';
      sql += ` ORDER BY ${safeSortKey} ${safeSortDir} LIMIT ? OFFSET ?`;

      const limit = parseInt(pageSize, 10);
      const offset = (parseInt(page, 10) - 1) * limit;
      params.push(limit, offset);

      const taskRuns = db.prepare(sql).all(...params).map(row => ({
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

      const totals = db.prepare(`
        SELECT
          COUNT(*) AS task_runs,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
          ) THEN 1 ELSE 0 END) AS with_canonical_outcome,
          SUM(CASE WHEN NOT EXISTS (
            SELECT 1 FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
          ) THEN 1 ELSE 0 END) AS no_canonical_outcome,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
              AND o.requires_human_intervention = 1
          ) THEN 1 ELSE 0 END) AS requires_human_intervention
        FROM task_runs tr
        WHERE ${whereSql}
      `).get(...params);

      const byOutcomeLabel = db.prepare(`
        SELECT o.outcome_label AS value, COUNT(*) AS count
        FROM task_runs tr
        JOIN outcomes o ON o.task_run_id = tr.id AND o.is_canonical = 1
        WHERE ${whereSql}
        GROUP BY o.outcome_label
        ORDER BY count DESC, value ASC
      `).all(...params);

      const byFailureMode = db.prepare(`
        SELECT o.failure_mode AS value, COUNT(*) AS count
        FROM task_runs tr
        JOIN outcomes o ON o.task_run_id = tr.id AND o.is_canonical = 1
        WHERE ${whereSql}
          AND o.failure_mode IS NOT NULL
        GROUP BY o.failure_mode
        ORDER BY count DESC, value ASC
      `).all(...params);

      const byFailureSubtype = db.prepare(`
        SELECT o.failure_subtype AS value, COUNT(*) AS count
        FROM task_runs tr
        JOIN outcomes o ON o.task_run_id = tr.id AND o.is_canonical = 1
        WHERE ${whereSql}
          AND o.failure_subtype IS NOT NULL
        GROUP BY o.failure_subtype
        ORDER BY count DESC, value ASC
      `).all(...params);

      const byEvaluationType = db.prepare(`
        SELECT o.evaluation_type AS value, COUNT(*) AS count
        FROM task_runs tr
        JOIN outcomes o ON o.task_run_id = tr.id AND o.is_canonical = 1
        WHERE ${whereSql}
        GROUP BY o.evaluation_type
        ORDER BY count DESC, value ASC
      `).all(...params);

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

      const eventRows = db.prepare(`
        SELECT e.key, e.data
        FROM task_run_events tre
        JOIN entries e ON e.key = tre.entry_key
        WHERE tre.task_run_id = ?
        ORDER BY e.ts ASC, e.id ASC
      `).all(req.params.id);

      const events = eventRows.map(row => ({ __key: row.key, ...parseJSONSafe(row.data, {}) }));
      const outcomes = db.prepare(`
        SELECT *
        FROM outcomes
        WHERE task_run_id = ?
        ORDER BY is_canonical DESC, evaluated_at DESC, id DESC
      `).all(req.params.id).map(row => ({
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
        canonicalOutcomeId: getTaskRunCanonicalOutcomeId(taskRunId),
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
