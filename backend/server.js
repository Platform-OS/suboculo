const fs = require('fs');
const path = require('path');
const { insertCEPEvent, insertCEPEventsBatch, validateCEPEvent } = require('./cep-processor');
const EventEmitter = require('events');
const logger = require('./logger');
const { createApp } = require('./app');
const { initDatabase } = require('./db/init');
const {
  OUTCOME_LABELS,
  EVALUATION_TYPES,
  FAILURE_TAXONOMY,
  FAILURE_MODES,
  OUTCOME_LABELS_REQUIRING_FAILURE_MODE,
  KPI_MIN_CANONICAL_SAMPLE,
  KPI_MIN_SUCCESS_SAMPLE_FOR_COST,
  DEFAULT_KPI_TARGETS
} = require('./domain/taxonomy');
const { createOutcomesDomain } = require('./domain/outcomes');
const { createReliabilityDomain } = require('./domain/reliability');
const { createTaskRunsDomain } = require('./domain/task-runs');
const { createTaskRunsRepository } = require('./repositories/task-runs-repository');
const { createOutcomesRepository } = require('./repositories/outcomes-repository');
const { createReliabilityRepository } = require('./repositories/reliability-repository');
const { createReviewAcknowledgementsRepository } = require('./repositories/review-acknowledgements-repository');
const { registerReliabilityRoutes } = require('./routes/reliability');
const { registerTaskRunRoutes } = require('./routes/task-runs');
const { registerEntriesRoutes } = require('./routes/entries');
const { registerAnalysesRoutes } = require('./routes/analyses');
const { registerAnnotationRoutes } = require('./routes/annotations');
const {
  parseOrRespond,
  eventBodySchema,
  eventBatchBodySchema,
  benchmarkIdParamsSchema,
  benchmarkRunCaseParamsSchema,
  benchmarkCreateBodySchema,
  benchmarkCaseCreateBodySchema,
  benchmarkRunCreateBodySchema,
  benchmarkRunResultBodySchema,
} = require('./routes/validation');

const PORT = process.env.SUBOCULO_PORT || 3000;
const HOST = process.env.SUBOCULO_HOST || '127.0.0.1';
const AUTO_LABEL_ENABLED = String(process.env.SUBOCULO_AUTO_LABEL ?? 'true').toLowerCase() !== 'false';
const KPI_THRESHOLDS_PATH = process.env.SUBOCULO_THRESHOLDS_PATH || path.join(process.cwd(), '.suboculo', 'thresholds.json');

// SSE Event Emitter for real-time updates
const sseEmitter = new EventEmitter();
sseEmitter.setMaxListeners(100); // Support up to 100 concurrent SSE connections

const frontendPath = path.join(__dirname, '../frontend');
const app = createApp({ frontendPath, logger });

// Database setup
// Defaults to ../events.db for per-project, or set SUBOCULO_DB_PATH for custom location
const dbPath = process.env.SUBOCULO_DB_PATH || path.join(__dirname, '../events.db');
const db = initDatabase({ dbPath, logger });

const taskRunsRepository = createTaskRunsRepository(db);
const outcomesRepository = createOutcomesRepository(db);
const reliabilityRepository = createReliabilityRepository(db);
const reviewAcknowledgementsRepository = createReviewAcknowledgementsRepository(db);

const outcomesDomain = createOutcomesDomain({
  outcomesRepository,
  taskRunsRepository,
  normalizeOptionalString,
  autoLabelEnabled: AUTO_LABEL_ENABLED
});

const taskRunsDomain = createTaskRunsDomain({
  taskRunsRepository,
  outcomesRepository,
  parseJSONSafe,
  autoLabelTaskRunIfEligible: outcomesDomain.autoLabelTaskRunIfEligible
});

const reliabilityDomain = createReliabilityDomain({
  reliabilityRepository,
  reviewAcknowledgementsRepository,
  fs,
  logger,
  thresholdsPath: KPI_THRESHOLDS_PATH,
  buildTaskRunsWhereClause: taskRunsDomain.buildTaskRunsWhereClause,
  normalizeOptionalString
});

const {
  validateOutcomePayload,
  insertOutcomeForTaskRun
} = outcomesDomain;

const {
  buildTaskRunsWhereClause,
  upsertTaskRunForRootSession,
  getTaskRunById,
  buildTaskRunAfterActionReport,
  getStoredTaskRunAfterActionReport,
  upsertStoredTaskRunAfterActionReport,
  isStoredTaskRunReportFresh,
  backfillAllTaskRuns
} = taskRunsDomain;

const {
  getConfiguredKpiTargets,
  buildReliabilityTrendsData,
  buildFailureModeTrendsData,
  fetchReliabilityRows,
  summarizeReliabilityKpis,
  deriveKpiAnomalies,
  buildReliabilityReviewData,
  getKpiComparePeriods,
  buildKpiCompareDeltas
} = reliabilityDomain;

// Helper: Generate unique key for entry
function generateKey(entry, idx) {
  const callId = entry?.callID || entry?.callId;
  if (callId && entry?.kind && entry?.ts) {
    return `${callId}::${entry.kind}::${entry.ts}`;
  }
  if (callId && entry?.kind) {
    return `${callId}::${entry.kind}::${idx}`;
  }
  if (entry?.sessionID && entry?.ts) {
    return `${entry.sessionID}::${entry.ts}::${idx}`;
  }
  return `idx::${idx}`;
}

// Decode base64-encoded fields from hooks (safe shell transport → readable storage)
function decodeBase64Fields(event) {
  if (!event.data) return;
  for (const field of ['args', 'response']) {
    if (typeof event.data[field] !== 'string') continue;
    try {
      event.data[field] = JSON.parse(Buffer.from(event.data[field], 'base64').toString('utf-8'));
    } catch {
      // Not base64 or not JSON — leave as-is
    }
  }
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJSONSafe(value, fallback = null) {
  const parsed = tryParseJson(value);
  return parsed === null ? fallback : parsed;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeIsoTimestampOrNull(value) {
  const str = normalizeOptionalString(value);
  if (!str) return null;
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

const initialDerivedTaskRuns = backfillAllTaskRuns();
logger.info(`[suboculo] Derived task runs on startup: ${initialDerivedTaskRuns}`);

// Generate SSE key — must match generateCEPKey logic for consistent dedup
function sseKey(event) {
  if (event.traceId && event.event) {
    return `${event.traceId}::${event.event}::${event.ts}`;
  }
  // Usage events: unique by session + model + agent + timestamp
  if (event.event === 'usage' && event.sessionId) {
    const agent = event.data?.agentId || 'lead';
    const model = event.data?.model || 'unknown';
    return `usage::${event.sessionId}::${model}::${agent}::${event.ts}`;
  }
  const agentId = event.data?.agentId;
  if (agentId && event.sessionId && event.event) {
    return `${event.sessionId}::${event.event}::${agentId}::${event.ts}`;
  }
  return `${event.sessionId || 'unknown'}::${event.event}::${event.ts}`;
}

// API: Ingest single CEP event (real-time)
// Notify endpoint - for hooks that already wrote to DB, just emit SSE
app.post('/api/notify', (req, res) => {
  try {
    const event = parseOrRespond(eventBodySchema, req.body, res);
    if (!event) return;

    // Calculate duration for tool.end events
    if (event.event === 'tool.end' && event.traceId) {
      try {
        const startEvent = db.prepare(`
          SELECT data FROM entries
          WHERE traceId = ? AND event = 'tool.start'
          ORDER BY ts DESC LIMIT 1
        `).get(event.traceId);

        if (startEvent) {
          const startData = tryParseJson(startEvent.data);
          if (startData?.ts) {
            const startTime = new Date(startData.ts);
            const endTime = new Date(event.ts);
            const durationMs = endTime - startTime;
            if (!event.data) event.data = {};
            event.data.durationMs = durationMs;
          }
        }
      } catch (err) {
        logger.warn('Failed to calculate duration:', err.message);
      }
    }

    // Decode base64 fields before emitting to SSE clients
    decodeBase64Fields(event);

    // Emit to SSE clients
    sseEmitter.emit('event', {
      __key: sseKey(event),
      ...event
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Notify error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Batch notify endpoint — for subagent extraction (events already in DB, just emit SSE)
app.post('/api/notify/batch', (req, res) => {
  try {
    const events = parseOrRespond(eventBatchBodySchema, req.body, res);
    if (!events) return;

    let emitted = 0;
    for (const event of events) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
      decodeBase64Fields(event);
      sseEmitter.emit('event', { __key: sseKey(event), ...event });
      emitted++;
    }

    res.json({ success: true, received: events.length, emitted });
  } catch (error) {
    logger.error('Batch notify error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ingest', (req, res) => {
  try {
    const event = parseOrRespond(eventBodySchema, req.body, res);
    if (!event) return;

    // Validate event
    const validation = validateCEPEvent(event);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid CEP event',
        details: validation.errors
      });
    }

    // Calculate duration for tool.end events
    if (event.event === 'tool.end' && event.traceId) {
      try {
        // Find matching tool.start event
        const startEvent = db.prepare(`
          SELECT data FROM entries
          WHERE traceId = ? AND event = 'tool.start'
          ORDER BY ts DESC LIMIT 1
        `).get(event.traceId);

        if (startEvent) {
          const startData = tryParseJson(startEvent.data);
          if (startData?.ts) {
            const startTime = new Date(startData.ts);
            const endTime = new Date(event.ts);
            const durationMs = endTime - startTime;

            // Add duration to event data
            if (!event.data) event.data = {};
            event.data.durationMs = durationMs;
          }
        }
      } catch (err) {
        logger.warn('Failed to calculate duration:', err.message);
        // Continue without duration - don't fail the ingestion
      }
    }

    // Insert event
    const key = insertCEPEvent(db, event);
    upsertTaskRunForRootSession(event.parentSessionId || event.sessionId);

    // Emit event for SSE clients (real-time updates)
    sseEmitter.emit('event', {
      __key: key,
      ...event
    });

    res.json({
      success: true,
      key,
      event: event.event
    });
  } catch (error) {
    logger.error('Ingest error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Ingest batch of CEP events
app.post('/api/ingest/batch', (req, res) => {
  try {
    const events = parseOrRespond(eventBatchBodySchema, req.body, res);
    if (!events) return;

    // Validate all events
    const invalidEvents = [];
    for (let i = 0; i < events.length; i++) {
      const validation = validateCEPEvent(events[i]);
      if (!validation.valid) {
        invalidEvents.push({
          index: i,
          errors: validation.errors
        });
      }
    }

    if (invalidEvents.length > 0) {
      return res.status(400).json({
        error: 'Some events are invalid',
        invalidEvents: invalidEvents.slice(0, 10) // Return first 10 invalid
      });
    }

    // Insert all events in transaction
    const count = insertCEPEventsBatch(db, events);
    const rootSessions = [...new Set(events.map(event => event.parentSessionId || event.sessionId).filter(Boolean))];
    for (const rootSessionId of rootSessions) {
      upsertTaskRunForRootSession(rootSessionId);
    }

    // Emit events for SSE clients (after transaction commits)
    events.forEach((event) => {
      sseEmitter.emit('event', {
        __key: sseKey(event),
        ...event
      });
    });

    res.json({
      success: true,
      count,
      total: events.length
    });
  } catch (error) {
    logger.error('Batch ingest error:', error);
    res.status(500).json({ error: error.message });
  }
});

registerTaskRunRoutes(app, {
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
});

registerReliabilityRoutes(app, {
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
});

registerEntriesRoutes(app, {
  db,
  logger,
  tryParseJson,
  decodeBase64Fields
});

registerAnalysesRoutes(app, {
  db,
  logger,
  tryParseJson,
  callAnthropicAPI
});

registerAnnotationRoutes(app, {
  db,
  dbPath,
  fs,
  path,
  logger,
  tryParseJson,
  decodeBase64Fields
});

app.get('/api/meta/outcome-taxonomy', (_req, res) => {
  res.json({
    evaluation_types: EVALUATION_TYPES,
    outcome_labels: OUTCOME_LABELS,
    failure_modes: FAILURE_MODES,
    failure_taxonomy: FAILURE_TAXONOMY,
    requires_failure_mode_for: [...OUTCOME_LABELS_REQUIRING_FAILURE_MODE]
  });
});

app.get('/api/benchmarks', (req, res) => {
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
    `).all().map(row => ({
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
    `).all(params.id).map(row => ({
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
    `).all(params.id).map(row => ({
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
    } = parseOrRespond(benchmarkCaseCreateBodySchema, req.body, res) || {};
    if (!case_key || !title) return;

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
    `).all(params.id).map(row => ({
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

// API: SSE stream for real-time events
logger.debug('[INIT] Registering SSE endpoint at /api/events/stream');
app.get('/api/events/stream', (req, res) => {
  logger.debug('[SSE] Client connecting to stream');
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send initial connection message
  res.write(': connected\n\n');

  // Heartbeat to keep connection alive (every 30 seconds)
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  // Listen for new events
  const listener = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      logger.error('SSE write error:', err.message);
    }
  };

  sseEmitter.on('event', listener);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    sseEmitter.off('event', listener);
    logger.debug('SSE client disconnected');
  });

  logger.debug('SSE client connected');
});

// Helper function to call Anthropic API
async function callAnthropicAPI(model, systemPrompt, userMessage, apiKey) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

// Start server
app.listen(PORT, HOST, () => {
  logger.info(`Server running on http://${HOST}:${PORT}`);
  logger.info(`Database: ${dbPath}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('\nClosing database...');
  db.close();
  process.exit(0);
});
