const {
  parseOrRespond,
  benchmarkIdParamsSchema,
  benchmarkRunCaseParamsSchema,
  benchmarkCreateBodySchema,
  benchmarkCaseCreateBodySchema,
  benchmarkRunCreateBodySchema,
  benchmarkRunResultBodySchema
} = require('./validation');

function registerBenchmarkRoutes(app, deps) {
  const {
    db,
    parseJSONSafe
  } = deps;

  app.get('/api/benchmarks', (_req, res) => {
    try {
      const benchmarks = db.prepare(`
        SELECT
          b.*,
          COUNT(DISTINCT bc.id) AS case_count,
          COUNT(DISTINCT br.id) AS run_count
        FROM benchmarks b
        LEFT JOIN benchmark_cases bc ON bc.benchmark_id = b.id
        LEFT JOIN benchmark_runs br ON br.benchmark_id = b.id
        GROUP BY b.id
        ORDER BY b.created_at DESC, b.id DESC
      `).all().map((row) => ({
        ...row,
        scoring_spec: parseJSONSafe(row.scoring_spec, null),
        policy_spec: parseJSONSafe(row.policy_spec, null)
      }));

      res.json(benchmarks);
    } catch (error) {
      console.error('List benchmarks error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/benchmarks', (req, res) => {
    try {
      const parsedBody = parseOrRespond(benchmarkCreateBodySchema, req.body, res);
      if (!parsedBody) return;

      const {
        name,
        description,
        version,
        status,
        task_definition_source,
        scoring_spec,
        policy_spec,
        owner
      } = parsedBody;

      const result = db.prepare(`
        INSERT INTO benchmarks (
          name, description, version, status, task_definition_source, scoring_spec, policy_spec, owner, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        name,
        description || null,
        version || '1.0.0',
        status || 'draft',
        task_definition_source || null,
        scoring_spec ? JSON.stringify(scoring_spec) : null,
        policy_spec ? JSON.stringify(policy_spec) : null,
        owner || null,
        new Date().toISOString()
      );

      res.json({ success: true, benchmarkId: result.lastInsertRowid });
    } catch (error) {
      console.error('Create benchmark error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/benchmarks/:id', (req, res) => {
    try {
      const params = parseOrRespond(benchmarkIdParamsSchema, req.params, res);
      if (!params) return;

      const benchmark = db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(params.id);
      if (!benchmark) {
        return res.status(404).json({ error: 'Benchmark not found' });
      }

      const cases = db.prepare(`
        SELECT *
        FROM benchmark_cases
        WHERE benchmark_id = ?
        ORDER BY case_key ASC, id ASC
      `).all(params.id).map((row) => ({
        ...row,
        allowed_tools: parseJSONSafe(row.allowed_tools, null),
        expected_outputs: parseJSONSafe(row.expected_outputs, null),
        forbidden_actions: parseJSONSafe(row.forbidden_actions, null),
        scoring_rules: parseJSONSafe(row.scoring_rules, null),
        metadata: parseJSONSafe(row.metadata, null)
      }));

      const runs = db.prepare(`
        SELECT *
        FROM benchmark_runs
        WHERE benchmark_id = ?
        ORDER BY created_at DESC, id DESC
      `).all(params.id).map((row) => ({
        ...row,
        agent_config: parseJSONSafe(row.agent_config, null),
        summary_json: parseJSONSafe(row.summary_json, null)
      }));

      res.json({
        ...benchmark,
        scoring_spec: parseJSONSafe(benchmark.scoring_spec, null),
        policy_spec: parseJSONSafe(benchmark.policy_spec, null),
        cases,
        runs
      });
    } catch (error) {
      console.error('Get benchmark error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/benchmarks/:id/cases', (req, res) => {
    try {
      const params = parseOrRespond(benchmarkIdParamsSchema, req.params, res);
      if (!params) return;

      const benchmark = db.prepare('SELECT id FROM benchmarks WHERE id = ?').get(params.id);
      if (!benchmark) {
        return res.status(404).json({ error: 'Benchmark not found' });
      }

      const parsedBody = parseOrRespond(benchmarkCaseCreateBodySchema, req.body, res);
      if (!parsedBody) return;

      const {
        case_key,
        title,
        description,
        prompt,
        fixture_ref,
        timeout_seconds,
        allowed_tools,
        expected_outputs,
        forbidden_actions,
        scoring_rules,
        metadata
      } = parsedBody;

      const result = db.prepare(`
        INSERT INTO benchmark_cases (
          benchmark_id, case_key, title, description, prompt, fixture_ref,
          timeout_seconds, allowed_tools, expected_outputs, forbidden_actions,
          scoring_rules, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.id,
        case_key,
        title,
        description || null,
        prompt || null,
        fixture_ref || null,
        timeout_seconds ?? null,
        allowed_tools ? JSON.stringify(allowed_tools) : null,
        expected_outputs ? JSON.stringify(expected_outputs) : null,
        forbidden_actions ? JSON.stringify(forbidden_actions) : null,
        scoring_rules ? JSON.stringify(scoring_rules) : null,
        metadata ? JSON.stringify(metadata) : null
      );

      res.json({ success: true, benchmarkCaseId: result.lastInsertRowid });
    } catch (error) {
      console.error('Create benchmark case error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/benchmarks/:id/runs', (req, res) => {
    try {
      const params = parseOrRespond(benchmarkIdParamsSchema, req.params, res);
      if (!params) return;

      const benchmark = db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(params.id);
      if (!benchmark) {
        return res.status(404).json({ error: 'Benchmark not found' });
      }

      const parsedBody = parseOrRespond(benchmarkRunCreateBodySchema, req.body, res);
      if (!parsedBody) return;

      const {
        status,
        agent_config,
        environment_fingerprint,
        git_revision,
        case_ids
      } = parsedBody;

      const cases = Array.isArray(case_ids) && case_ids.length > 0
        ? db.prepare(`
            SELECT id
            FROM benchmark_cases
            WHERE benchmark_id = ? AND id IN (${case_ids.map(() => '?').join(',')})
          `).all(params.id, ...case_ids)
        : db.prepare('SELECT id FROM benchmark_cases WHERE benchmark_id = ?').all(params.id);

      const createRun = db.transaction(() => {
        const run = db.prepare(`
          INSERT INTO benchmark_runs (
            benchmark_id, status, agent_config, environment_fingerprint, git_revision, started_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          params.id,
          status || 'planned',
          agent_config ? JSON.stringify(agent_config) : null,
          environment_fingerprint || null,
          git_revision || null,
          new Date().toISOString()
        );

        const runId = run.lastInsertRowid;
        const insertCase = db.prepare(`
          INSERT INTO benchmark_run_cases (
            benchmark_run_id, benchmark_case_id, status, metadata
          ) VALUES (?, ?, ?, ?)
        `);

        for (const row of cases) {
          insertCase.run(runId, row.id, 'planned', null);
        }

        return runId;
      });

      const benchmarkRunId = createRun();
      res.json({ success: true, benchmarkRunId, caseCount: cases.length });
    } catch (error) {
      console.error('Create benchmark run error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/benchmark-runs/:id', (req, res) => {
    try {
      const params = parseOrRespond(benchmarkIdParamsSchema, req.params, res);
      if (!params) return;

      const run = db.prepare(`
        SELECT br.*, b.name AS benchmark_name, b.version AS benchmark_version
        FROM benchmark_runs br
        JOIN benchmarks b ON b.id = br.benchmark_id
        WHERE br.id = ?
      `).get(params.id);

      if (!run) {
        return res.status(404).json({ error: 'Benchmark run not found' });
      }

      const cases = db.prepare(`
        SELECT
          brc.*,
          bc.case_key,
          bc.title AS case_title,
          tr.task_key,
          tr.title AS task_run_title,
          o.outcome_label
        FROM benchmark_run_cases brc
        JOIN benchmark_cases bc ON bc.id = brc.benchmark_case_id
        LEFT JOIN task_runs tr ON tr.id = brc.task_run_id
        LEFT JOIN outcomes o ON o.id = brc.outcome_id
        WHERE brc.benchmark_run_id = ?
        ORDER BY bc.case_key ASC, brc.id ASC
      `).all(params.id).map((row) => ({
        ...row,
        metadata: parseJSONSafe(row.metadata, null)
      }));

      res.json({
        ...run,
        agent_config: parseJSONSafe(run.agent_config, null),
        summary_json: parseJSONSafe(run.summary_json, null),
        cases
      });
    } catch (error) {
      console.error('Get benchmark run error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/benchmark-runs/:id/cases/:caseId/result', (req, res) => {
    try {
      const params = parseOrRespond(benchmarkRunCaseParamsSchema, req.params, res);
      if (!params) return;

      const runCase = db.prepare(`
        SELECT brc.*
        FROM benchmark_run_cases brc
        WHERE brc.benchmark_run_id = ? AND brc.benchmark_case_id = ?
      `).get(params.id, params.caseId);

      if (!runCase) {
        return res.status(404).json({ error: 'Benchmark run case not found' });
      }

      const parsedBody = parseOrRespond(benchmarkRunResultBodySchema, req.body, res);
      if (!parsedBody) return;

      const { task_run_id, outcome_id, status, score, notes, metadata } = parsedBody;

      db.prepare(`
        UPDATE benchmark_run_cases
        SET task_run_id = ?, outcome_id = ?, status = ?, score = ?, notes = ?, metadata = ?
        WHERE benchmark_run_id = ? AND benchmark_case_id = ?
      `).run(
        task_run_id || null,
        outcome_id || null,
        status || runCase.status,
        score ?? null,
        notes || null,
        metadata ? JSON.stringify(metadata) : null,
        params.id,
        params.caseId
      );

      const summary = db.prepare(`
        SELECT
          COUNT(*) AS total_cases,
          SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed_cases,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_cases,
          SUM(CASE WHEN status IN ('passed', 'failed', 'skipped') THEN 1 ELSE 0 END) AS completed_cases,
          AVG(score) AS avg_score
        FROM benchmark_run_cases
        WHERE benchmark_run_id = ?
      `).get(params.id);

      db.prepare(`
        UPDATE benchmark_runs
        SET
          summary_json = ?,
          status = CASE
            WHEN ? >= ? THEN 'completed'
            ELSE status
          END,
          ended_at = CASE
            WHEN ? >= ? THEN CURRENT_TIMESTAMP
            ELSE ended_at
          END
        WHERE id = ?
      `).run(
        JSON.stringify(summary),
        summary.completed_cases || 0,
        summary.total_cases || 0,
        summary.completed_cases || 0,
        summary.total_cases || 0,
        params.id
      );

      res.json({ success: true, summary });
    } catch (error) {
      console.error('Update benchmark run case result error:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = {
  registerBenchmarkRoutes
};
