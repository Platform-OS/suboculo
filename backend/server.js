const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { insertCEPEvent, insertCEPEventsBatch, validateCEPEvent } = require('./cep-processor');
const EventEmitter = require('events');

const app = express();
const PORT = process.env.SUBOCULO_PORT || 3000;

// SSE Event Emitter for real-time updates
const sseEmitter = new EventEmitter();
sseEmitter.setMaxListeners(100); // Support up to 100 concurrent SSE connections

// Middleware
app.use(express.json({ limit: '10mb' }));

// Serve static frontend files
const frontendPath = path.join(__dirname, '../frontend');
console.log('[suboculo] Checking frontend path:', frontendPath);
console.log('[suboculo] Frontend exists?', fs.existsSync(frontendPath));
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath, {
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      // HTML: always revalidate (picks up new hashed asset references)
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
      // Hashed assets (Vite adds content hash): cache long-term
      else if (filePath.match(/\.[a-f0-9]{8,}\./)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));
  console.log('[suboculo] Static files enabled from:', frontendPath);
} else {
  console.log('[suboculo] Frontend not found - web UI unavailable');
}

// Database setup
// Defaults to ../events.db for per-project, or set SUBOCULO_DB_PATH for custom location
const dbPath = process.env.SUBOCULO_DB_PATH || path.join(__dirname, '../events.db');
let db;

function initDatabase() {
  db = new Database(dbPath);

  // Create analyses table
  db.exec(`
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      model TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      event_keys TEXT NOT NULL,
      analysis TEXT NOT NULL,
      prompt TEXT
    );
  `);

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      ts TEXT,
      kind TEXT,
      type TEXT,
      tool TEXT,
      sessionID TEXT,
      rootSessionID TEXT,
      subagentType TEXT,
      callID TEXT,
      durationMs INTEGER,
      outputLen INTEGER,
      outputPreview TEXT,
      title TEXT,
      parentSessionID TEXT,
      childSessionID TEXT,
      args TEXT,
      data TEXT NOT NULL
    );

    -- Add CEP-specific columns if they don't exist
    -- This allows backward compatibility with existing databases
    PRAGMA table_info(entries);
  `);

  // Add runner and event columns if they don't exist (migration)
  try {
    db.exec(`ALTER TABLE entries ADD COLUMN runner TEXT`);
    console.log('Added column: runner');
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN event TEXT`);
    console.log('Added column: event');
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN traceId TEXT`);
    console.log('Added column: traceId');
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN status TEXT`);
    console.log('Added column: status');
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN agentId TEXT`);
    console.log('Added column: agentId');
  } catch (e) {
    // Column already exists
  }

  // Create indexes for CEP fields
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runner ON entries(runner);
    CREATE INDEX IF NOT EXISTS idx_event ON entries(event);
    CREATE INDEX IF NOT EXISTS idx_traceId ON entries(traceId);
    CREATE INDEX IF NOT EXISTS idx_status ON entries(status);
    CREATE INDEX IF NOT EXISTS idx_agentId ON entries(agentId);
    CREATE INDEX IF NOT EXISTS idx_kind ON entries(kind);
    CREATE INDEX IF NOT EXISTS idx_type ON entries(type);
    CREATE INDEX IF NOT EXISTS idx_tool ON entries(tool);
    CREATE INDEX IF NOT EXISTS idx_ts ON entries(ts);
    CREATE INDEX IF NOT EXISTS idx_sessionID ON entries(sessionID);
    CREATE INDEX IF NOT EXISTS idx_rootSessionID ON entries(rootSessionID);
    CREATE INDEX IF NOT EXISTS idx_subagentType ON entries(subagentType);
  `);

  // Create tags and notes tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_key TEXT NOT NULL,
      tag TEXT NOT NULL,
      UNIQUE(entry_key, tag)
    );

    CREATE INDEX IF NOT EXISTS idx_tags_entry ON tags(entry_key);
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

    CREATE TABLE IF NOT EXISTS notes (
      entry_key TEXT PRIMARY KEY,
      note TEXT NOT NULL
    );
  `);

  // Phase 2: task-centric reliability model
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key TEXT UNIQUE NOT NULL,
      title TEXT,
      description TEXT,
      source TEXT NOT NULL DEFAULT 'derived_session',
      runner TEXT,
      model TEXT,
      agent_system_version TEXT,
      prompt_version TEXT,
      toolchain_version TEXT,
      environment_fingerprint TEXT,
      git_revision TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      root_session_id TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      total_events INTEGER NOT NULL DEFAULT 0,
      total_tool_calls INTEGER NOT NULL DEFAULT 0,
      distinct_tools INTEGER NOT NULL DEFAULT 0,
      total_duration_ms INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      subagent_count INTEGER NOT NULL DEFAULT 0,
      interrupt_count INTEGER NOT NULL DEFAULT 0,
      token_input INTEGER NOT NULL DEFAULT 0,
      token_output INTEGER NOT NULL DEFAULT 0,
      token_cache_creation INTEGER NOT NULL DEFAULT 0,
      token_cache_read INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_task_runs_root_session ON task_runs(root_session_id);
    CREATE INDEX IF NOT EXISTS idx_task_runs_runner ON task_runs(runner);
    CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
    CREATE INDEX IF NOT EXISTS idx_task_runs_started_at ON task_runs(started_at);

    CREATE TABLE IF NOT EXISTS task_run_events (
      task_run_id INTEGER NOT NULL,
      entry_key TEXT NOT NULL,
      PRIMARY KEY (task_run_id, entry_key),
      FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_run_events_entry_key ON task_run_events(entry_key);

    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_run_id INTEGER NOT NULL,
      evaluation_type TEXT NOT NULL,
      outcome_label TEXT NOT NULL,
      correctness_score REAL,
      safety_score REAL,
      efficiency_score REAL,
      reproducibility_score REAL,
      requires_human_intervention INTEGER NOT NULL DEFAULT 0,
      failure_mode TEXT,
      failure_subtype TEXT,
      notes TEXT,
      evaluator TEXT,
      evidence TEXT,
      is_canonical INTEGER NOT NULL DEFAULT 0,
      evaluated_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_outcomes_task_run_id ON outcomes(task_run_id);
    CREATE INDEX IF NOT EXISTS idx_outcomes_label ON outcomes(outcome_label);
    CREATE INDEX IF NOT EXISTS idx_outcomes_canonical ON outcomes(is_canonical);

    CREATE TABLE IF NOT EXISTS benchmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      version TEXT NOT NULL DEFAULT '1.0.0',
      status TEXT NOT NULL DEFAULT 'draft',
      task_definition_source TEXT,
      scoring_spec TEXT,
      policy_spec TEXT,
      owner TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name, version)
    );

    CREATE TABLE IF NOT EXISTS benchmark_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benchmark_id INTEGER NOT NULL,
      case_key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      prompt TEXT,
      fixture_ref TEXT,
      timeout_seconds INTEGER,
      allowed_tools TEXT,
      expected_outputs TEXT,
      forbidden_actions TEXT,
      scoring_rules TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (benchmark_id) REFERENCES benchmarks(id) ON DELETE CASCADE,
      UNIQUE(benchmark_id, case_key)
    );

    CREATE INDEX IF NOT EXISTS idx_benchmark_cases_benchmark_id ON benchmark_cases(benchmark_id);

    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benchmark_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      agent_config TEXT,
      environment_fingerprint TEXT,
      git_revision TEXT,
      started_at TEXT,
      ended_at TEXT,
      summary_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (benchmark_id) REFERENCES benchmarks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_benchmark_runs_benchmark_id ON benchmark_runs(benchmark_id);

    CREATE TABLE IF NOT EXISTS benchmark_run_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benchmark_run_id INTEGER NOT NULL,
      benchmark_case_id INTEGER NOT NULL,
      task_run_id INTEGER,
      outcome_id INTEGER,
      status TEXT NOT NULL DEFAULT 'planned',
      score REAL,
      notes TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (benchmark_run_id) REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (benchmark_case_id) REFERENCES benchmark_cases(id) ON DELETE CASCADE,
      FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE SET NULL,
      FOREIGN KEY (outcome_id) REFERENCES outcomes(id) ON DELETE SET NULL,
      UNIQUE(benchmark_run_id, benchmark_case_id)
    );

    CREATE INDEX IF NOT EXISTS idx_benchmark_run_cases_run_id ON benchmark_run_cases(benchmark_run_id);
    CREATE INDEX IF NOT EXISTS idx_benchmark_run_cases_task_run_id ON benchmark_run_cases(task_run_id);
  `);

  console.log('Database initialized');
}

// Initialize DB on startup
initDatabase();

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

function parseJSONSafe(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function deriveTaskRunStatus(rows) {
  const events = rows.map(row => row.event);
  if (events.includes('error')) return 'failed';

  const endRows = rows.filter(row => row.event === 'session.end');
  if (endRows.length > 0) {
    const lastEnd = parseJSONSafe(endRows[endRows.length - 1].data, {});
    const reason = lastEnd?.data?.reason;
    if (reason === 'cancelled' || reason === 'user_cancelled') return 'cancelled';
    if (reason === 'timeout' || reason === 'timed_out') return 'timed_out';
  }

  if (events.includes('session.end')) return 'completed';
  return 'running';
}

function summarizeTaskRunRows(rows) {
  const parsed = rows.map(row => parseJSONSafe(row.data, {}));
  const first = parsed[0] || {};
  const last = parsed[parsed.length - 1] || {};
  const toolEndRows = parsed.filter(event => event.event === 'tool.end');
  const distinctTools = new Set(parsed.map(event => event?.data?.tool).filter(Boolean));
  const usageRows = parsed.filter(event => event.event === 'usage');
  const subagentIds = new Set(parsed.map(event => event?.data?.agentId).filter(Boolean));

  let tokenInput = 0;
  let tokenOutput = 0;
  let tokenCacheCreation = 0;
  let tokenCacheRead = 0;
  let estimatedCost = 0;
  let interruptCount = 0;

  for (const event of usageRows) {
    const data = event.data || {};
    tokenInput += data.inputTokens || 0;
    tokenOutput += data.outputTokens || 0;
    tokenCacheCreation += data.cacheCreationTokens || 0;
    tokenCacheRead += data.cacheReadTokens || 0;
    estimatedCost += data.cost || 0;
  }

  for (const event of parsed) {
    if (event?.data?.isInterrupt) interruptCount++;
  }

  const sessionStart = parsed.find(event => event.event === 'session.start');
  const title = sessionStart?.data?.title || first?.data?.title || null;
  const description = sessionStart?.data?.directory || null;
  const model = usageRows.find(event => event?.data?.model)?.data?.model || null;

  return {
    title,
    description,
    runner: first.runner || null,
    model,
    startedAt: first.ts || null,
    endedAt: last.ts || null,
    status: deriveTaskRunStatus(rows),
    totalEvents: rows.length,
    totalToolCalls: toolEndRows.length,
    distinctTools: distinctTools.size,
    totalDurationMs: toolEndRows.reduce((sum, event) => sum + (event.data?.durationMs || 0), 0),
    errorCount: parsed.filter(event =>
      event.event === 'error' || (event.event === 'tool.end' && event.data?.status === 'error')
    ).length,
    retryCount: Math.max(toolEndRows.length - distinctTools.size, 0),
    subagentCount: subagentIds.size,
    interruptCount,
    tokenInput,
    tokenOutput,
    tokenCacheCreation,
    tokenCacheRead,
    estimatedCost: +estimatedCost.toFixed(6),
    metadata: JSON.stringify({
      sessionIds: [...new Set(rows.map(row => row.sessionID).filter(Boolean))],
      tools: [...distinctTools]
    })
  };
}

function upsertTaskRunForRootSession(rootSessionId) {
  if (!rootSessionId) return null;

  const rows = db.prepare(`
    SELECT key, ts, sessionID, rootSessionID, runner, event, data
    FROM entries
    WHERE rootSessionID = ? OR sessionID = ?
    ORDER BY ts ASC, id ASC
  `).all(rootSessionId, rootSessionId);

  if (rows.length === 0) return null;

  const summary = summarizeTaskRunRows(rows);
  const taskKey = `root:${rootSessionId}`;

  const upsert = db.prepare(`
    INSERT INTO task_runs (
      task_key, title, description, source, runner, model, status, root_session_id,
      started_at, ended_at, total_events, total_tool_calls, distinct_tools,
      total_duration_ms, error_count, retry_count, subagent_count, interrupt_count,
      token_input, token_output, token_cache_creation, token_cache_read,
      estimated_cost, metadata, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_key) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      source = excluded.source,
      runner = excluded.runner,
      model = excluded.model,
      status = excluded.status,
      root_session_id = excluded.root_session_id,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      total_events = excluded.total_events,
      total_tool_calls = excluded.total_tool_calls,
      distinct_tools = excluded.distinct_tools,
      total_duration_ms = excluded.total_duration_ms,
      error_count = excluded.error_count,
      retry_count = excluded.retry_count,
      subagent_count = excluded.subagent_count,
      interrupt_count = excluded.interrupt_count,
      token_input = excluded.token_input,
      token_output = excluded.token_output,
      token_cache_creation = excluded.token_cache_creation,
      token_cache_read = excluded.token_cache_read,
      estimated_cost = excluded.estimated_cost,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
  `);

  upsert.run(
    taskKey,
    summary.title,
    summary.description,
    'derived_session',
    summary.runner,
    summary.model,
    summary.status,
    rootSessionId,
    summary.startedAt,
    summary.endedAt,
    summary.totalEvents,
    summary.totalToolCalls,
    summary.distinctTools,
    summary.totalDurationMs,
    summary.errorCount,
    summary.retryCount,
    summary.subagentCount,
    summary.interruptCount,
    summary.tokenInput,
    summary.tokenOutput,
    summary.tokenCacheCreation,
    summary.tokenCacheRead,
    summary.estimatedCost,
    summary.metadata,
    new Date().toISOString()
  );

  const taskRun = db.prepare('SELECT id, task_key FROM task_runs WHERE task_key = ?').get(taskKey);
  const replaceLinks = db.transaction((taskRunId, eventRows) => {
    db.prepare('DELETE FROM task_run_events WHERE task_run_id = ?').run(taskRunId);
    const insertLink = db.prepare(`
      INSERT OR IGNORE INTO task_run_events (task_run_id, entry_key)
      VALUES (?, ?)
    `);
    for (const row of eventRows) {
      insertLink.run(taskRunId, row.key);
    }
  });
  replaceLinks(taskRun.id, rows);
  return taskRun.id;
}

function getTaskRunById(taskRunId) {
  return db.prepare(`
    SELECT *
    FROM task_runs
    WHERE id = ?
  `).get(taskRunId);
}

function backfillAllTaskRuns() {
  const rows = db.prepare(`
    SELECT DISTINCT COALESCE(rootSessionID, sessionID) AS rootSessionId
    FROM entries
    WHERE COALESCE(rootSessionID, sessionID) IS NOT NULL
    ORDER BY rootSessionId
  `).all();

  let derived = 0;
  for (const row of rows) {
    const taskRunId = upsertTaskRunForRootSession(row.rootSessionId);
    if (taskRunId) derived++;
  }
  return derived;
}

const initialDerivedTaskRuns = backfillAllTaskRuns();
console.log(`[suboculo] Derived task runs on startup: ${initialDerivedTaskRuns}`);

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
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }
    const event = req.body;

    // Calculate duration for tool.end events
    if (event.event === 'tool.end' && event.traceId) {
      try {
        const startEvent = db.prepare(`
          SELECT data FROM entries
          WHERE traceId = ? AND event = 'tool.start'
          ORDER BY ts DESC LIMIT 1
        `).get(event.traceId);

        if (startEvent) {
          const startData = JSON.parse(startEvent.data);
          const startTime = new Date(startData.ts);
          const endTime = new Date(event.ts);
          const durationMs = endTime - startTime;
          if (!event.data) event.data = {};
          event.data.durationMs = durationMs;
        }
      } catch (err) {
        console.warn('Failed to calculate duration:', err.message);
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
    console.error('Notify error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Batch notify endpoint — for subagent extraction (events already in DB, just emit SSE)
app.post('/api/notify/batch', (req, res) => {
  try {
    const events = req.body;
    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'Expected array of events' });
    }

    let emitted = 0;
    for (const event of events) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
      decodeBase64Fields(event);
      sseEmitter.emit('event', { __key: sseKey(event), ...event });
      emitted++;
    }

    res.json({ success: true, received: events.length, emitted });
  } catch (error) {
    console.error('Batch notify error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ingest', (req, res) => {
  try {
    const event = req.body;

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
          const startData = JSON.parse(startEvent.data);
          const startTime = new Date(startData.ts);
          const endTime = new Date(event.ts);
          const durationMs = endTime - startTime;

          // Add duration to event data
          if (!event.data) event.data = {};
          event.data.durationMs = durationMs;
        }
      } catch (err) {
        console.warn('Failed to calculate duration:', err.message);
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
    console.error('Ingest error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Ingest batch of CEP events
app.post('/api/ingest/batch', (req, res) => {
  try {
    const events = req.body;

    if (!Array.isArray(events)) {
      return res.status(400).json({
        error: 'Expected array of events'
      });
    }

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
    console.error('Batch ingest error:', error);
    res.status(500).json({ error: error.message });
  }
});

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
      runner,
      status,
      source,
      query,
      sortKey = 'started_at',
      sortDir = 'desc'
    } = req.query;

    let sql = 'SELECT * FROM task_runs WHERE 1=1';
    const params = [];

    if (runner && runner !== 'all') {
      sql += ' AND runner = ?';
      params.push(runner);
    }
    if (status && status !== 'all') {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (source && source !== 'all') {
      sql += ' AND source = ?';
      params.push(source);
    }
    if (query) {
      sql += ' AND (task_key LIKE ? OR title LIKE ? OR description LIKE ? OR root_session_id LIKE ?)';
      const like = `%${query}%`;
      params.push(like, like, like, like);
    }

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

app.post('/api/task-runs/:id/outcomes', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const taskRun = getTaskRunById(req.params.id);
    if (!taskRun) {
      return res.status(404).json({ error: 'Task run not found' });
    }

    const {
      evaluation_type,
      outcome_label,
      correctness_score,
      safety_score,
      efficiency_score,
      reproducibility_score,
      requires_human_intervention,
      failure_mode,
      failure_subtype,
      notes,
      evaluator,
      evidence,
      is_canonical
    } = req.body;

    if (!evaluation_type || !outcome_label) {
      return res.status(400).json({ error: 'evaluation_type and outcome_label are required' });
    }

    const insertOutcome = db.transaction(() => {
      if (is_canonical) {
        db.prepare('UPDATE outcomes SET is_canonical = 0 WHERE task_run_id = ?').run(req.params.id);
      }

      return db.prepare(`
        INSERT INTO outcomes (
          task_run_id, evaluation_type, outcome_label, correctness_score, safety_score,
          efficiency_score, reproducibility_score, requires_human_intervention,
          failure_mode, failure_subtype, notes, evaluator, evidence, is_canonical, evaluated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.params.id,
        evaluation_type,
        outcome_label,
        correctness_score ?? null,
        safety_score ?? null,
        efficiency_score ?? null,
        reproducibility_score ?? null,
        requires_human_intervention ? 1 : 0,
        failure_mode || null,
        failure_subtype || null,
        notes || null,
        evaluator || null,
        evidence ? JSON.stringify(evidence) : null,
        is_canonical ? 1 : 0,
        new Date().toISOString()
      );
    });

    const result = insertOutcome();
    res.json({ success: true, outcomeId: result.lastInsertRowid });
  } catch (error) {
    console.error('Create outcome error:', error);
    res.status(500).json({ error: error.message });
  }
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
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const { name, description, version, status, task_definition_source, scoring_spec, policy_spec, owner } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

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
    const benchmark = db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(req.params.id);
    if (!benchmark) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const cases = db.prepare(`
      SELECT *
      FROM benchmark_cases
      WHERE benchmark_id = ?
      ORDER BY case_key ASC, id ASC
    `).all(req.params.id).map(row => ({
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
    `).all(req.params.id).map(row => ({
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
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const benchmark = db.prepare('SELECT id FROM benchmarks WHERE id = ?').get(req.params.id);
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
    } = req.body;

    if (!case_key || !title) {
      return res.status(400).json({ error: 'case_key and title are required' });
    }

    const result = db.prepare(`
      INSERT INTO benchmark_cases (
        benchmark_id, case_key, title, description, prompt, fixture_ref,
        timeout_seconds, allowed_tools, expected_outputs, forbidden_actions,
        scoring_rules, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
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
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const benchmark = db.prepare('SELECT * FROM benchmarks WHERE id = ?').get(req.params.id);
    if (!benchmark) {
      return res.status(404).json({ error: 'Benchmark not found' });
    }

    const { status, agent_config, environment_fingerprint, git_revision, case_ids } = req.body;
    const cases = Array.isArray(case_ids) && case_ids.length > 0
      ? db.prepare(`
          SELECT id
          FROM benchmark_cases
          WHERE benchmark_id = ? AND id IN (${case_ids.map(() => '?').join(',')})
        `).all(req.params.id, ...case_ids)
      : db.prepare('SELECT id FROM benchmark_cases WHERE benchmark_id = ?').all(req.params.id);

    const createRun = db.transaction(() => {
      const run = db.prepare(`
        INSERT INTO benchmark_runs (
          benchmark_id, status, agent_config, environment_fingerprint, git_revision, started_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        req.params.id,
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
    const run = db.prepare(`
      SELECT br.*, b.name AS benchmark_name, b.version AS benchmark_version
      FROM benchmark_runs br
      JOIN benchmarks b ON b.id = br.benchmark_id
      WHERE br.id = ?
    `).get(req.params.id);

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
    `).all(req.params.id).map(row => ({
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
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const runCase = db.prepare(`
      SELECT brc.*
      FROM benchmark_run_cases brc
      WHERE brc.benchmark_run_id = ? AND brc.benchmark_case_id = ?
    `).get(req.params.id, req.params.caseId);

    if (!runCase) {
      return res.status(404).json({ error: 'Benchmark run case not found' });
    }

    const { task_run_id, outcome_id, status, score, notes, metadata } = req.body;

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
      req.params.id,
      req.params.caseId
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
    `).get(req.params.id);

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
      req.params.id
    );

    res.json({ success: true, summary });
  } catch (error) {
    console.error('Update benchmark run case result error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get entries with filters and pagination
app.get('/api/entries', (req, res) => {
  try {
    const {
      page = 1,
      pageSize = 100,
      kind,
      type,
      tool,
      subagent,
      rootSession,
      tag,
      query,
      sortKey = 'ts',
      sortDir = 'desc',
      runner,
      event
    } = req.query;

    let sql = 'SELECT * FROM entries WHERE 1=1';
    const params = [];

    // Apply CEP filters
    if (runner && runner !== 'all') {
      sql += ' AND runner = ?';
      params.push(runner);
    }

    if (event && event !== 'all') {
      sql += ' AND event = ?';
      params.push(event);
    }

    // Apply legacy filters (backward compat)
    if (kind && kind !== 'all') {
      sql += ' AND (kind = ? OR event = ?)';
      params.push(kind, kind);
    }

    if (type && type !== 'all') {
      sql += ' AND type = ?';
      params.push(type);
    }

    if (tool && tool !== 'all') {
      sql += ' AND tool = ?';
      params.push(tool);
    }

    if (subagent && subagent !== 'all') {
      sql += ' AND subagentType = ?';
      params.push(subagent);
    }

    if (rootSession && rootSession !== 'all') {
      sql += ' AND rootSessionID = ?';
      params.push(rootSession);
    }

    if (tag && tag !== 'all') {
      sql += ' AND key IN (SELECT entry_key FROM tags WHERE tag = ?)';
      params.push(tag);
    }

    if (query) {
      sql += ` AND (
        kind LIKE ? OR
        type LIKE ? OR
        tool LIKE ? OR
        sessionID LIKE ? OR
        rootSessionID LIKE ? OR
        callID LIKE ? OR
        title LIKE ? OR
        outputPreview LIKE ? OR
        args LIKE ? OR
        key IN (SELECT entry_key FROM tags WHERE tag LIKE ?) OR
        key IN (SELECT entry_key FROM notes WHERE note LIKE ?)
      )`;
      const likeQuery = `%${query}%`;
      params.push(...Array(11).fill(likeQuery));
    }

    // Count total matching
    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as count');
    const countResult = db.prepare(countSql).get(...params);
    const total = countResult.count;

    // Add sorting
    const allowedSortKeys = ['ts', 'kind', 'tool', 'durationMs'];
    const safeSortKey = allowedSortKeys.includes(sortKey) ? sortKey : 'ts';
    const safeSortDir = sortDir === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${safeSortKey} ${safeSortDir}`;

    // Add pagination
    const limit = parseInt(pageSize);
    const offset = (parseInt(page) - 1) * limit;
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    // Execute query
    const entries = db.prepare(sql).all(...params);

    // Return clean CEP events, supplementing with DB column values
    const parsedEntries = entries.map(row => {
      const cepEvent = JSON.parse(row.data);

      // Supplement event data with DB column values for older entries
      // where these weren't stored in the JSON blob
      if (!cepEvent.data) cepEvent.data = {};
      if (row.durationMs != null && cepEvent.data.durationMs == null) {
        cepEvent.data.durationMs = row.durationMs;
      }
      if (row.status && !cepEvent.data.status) {
        cepEvent.data.status = row.status;
      }

      // Decode base64-encoded fields from older entries
      decodeBase64Fields(cepEvent);

      // Add __key for Svelte's keyed each blocks
      return {
        __key: row.key,
        ...cepEvent
      };
    });

    res.json({
      entries: parsedEntries,
      total,
      page: parseInt(page),
      pageSize: limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Query error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get facets (unique values for filters)
app.get('/api/facets', (req, res) => {
  try {
    const kinds = db.prepare('SELECT DISTINCT kind FROM entries WHERE kind IS NOT NULL ORDER BY kind').all();
    const types = db.prepare('SELECT DISTINCT type FROM entries WHERE type IS NOT NULL ORDER BY type').all();
    const tools = db.prepare('SELECT DISTINCT tool FROM entries WHERE tool IS NOT NULL ORDER BY tool').all();
    const subagents = db.prepare('SELECT DISTINCT subagentType FROM entries WHERE subagentType IS NOT NULL ORDER BY subagentType').all();
    const roots = db.prepare('SELECT DISTINCT rootSessionID FROM entries WHERE rootSessionID IS NOT NULL').all();
    const allTags = db.prepare('SELECT DISTINCT tag FROM tags ORDER BY tag').all();

    // CEP-specific facets
    const runners = db.prepare('SELECT DISTINCT runner FROM entries WHERE runner IS NOT NULL ORDER BY runner').all();
    const events = db.prepare('SELECT DISTINCT event FROM entries WHERE event IS NOT NULL ORDER BY event').all();

    res.json({
      kinds: kinds.map(r => r.kind),
      types: types.map(r => r.type),
      tools: tools.map(r => r.tool),
      subagents: subagents.map(r => r.subagentType),
      roots: roots.map(r => r.rootSessionID),
      allTags: allTags.map(r => r.tag),
      runners: runners.map(r => r.runner),
      events: events.map(r => r.event)
    });
  } catch (error) {
    console.error('Facets error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get statistics
app.get('/api/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as count FROM entries').get();
    const avgDur = db.prepare(`
      SELECT AVG(durationMs) as avg
      FROM entries
      WHERE event = 'tool.end' AND durationMs IS NOT NULL
    `).get();

    res.json({
      total: total.count,
      avgDur: avgDur.avg ? Math.round(avgDur.avg) : null
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get all analyses (history)
app.get('/api/analyses-history', (req, res) => {
  try {
    const analyses = db.prepare(`
      SELECT id, timestamp, model, event_count, analysis, prompt
      FROM analyses
      ORDER BY timestamp DESC
    `).all();

    res.json(analyses);
  } catch (error) {
    console.error('Get analyses error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get single analysis
app.get('/api/analyses-history/:id', (req, res) => {
  try {
    const { id } = req.params;
    const analysis = db.prepare(`
      SELECT * FROM analyses WHERE id = ?
    `).get(id);

    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' });
    }

    analysis.event_keys = JSON.parse(analysis.event_keys);
    res.json(analysis);
  } catch (error) {
    console.error('Get analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Save externally-generated analysis (e.g. from CLI via MCP)
app.post('/api/analyses', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }
    const { model, event_count, event_keys, analysis, prompt } = req.body;

    if (!analysis || typeof analysis !== 'string') {
      return res.status(400).json({ error: 'analysis (string) is required' });
    }

    const analysisId = db.prepare(`
      INSERT INTO analyses (timestamp, model, event_count, event_keys, analysis, prompt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      model || 'claude-code-cli',
      event_count || 0,
      JSON.stringify(event_keys || []),
      analysis,
      prompt || null
    ).lastInsertRowid;

    res.json({ success: true, analysisId });
  } catch (error) {
    console.error('Save analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Delete analysis
app.delete('/api/analyses-history/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM analyses WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: SSE stream for real-time events
console.log('[INIT] Registering SSE endpoint at /api/events/stream');
app.get('/api/events/stream', (req, res) => {
  console.log('[SSE] Client connecting to stream');
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
      console.error('SSE write error:', err.message);
    }
  };

  sseEmitter.on('event', listener);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    sseEmitter.off('event', listener);
    console.log('SSE client disconnected');
  });

  console.log('SSE client connected');
});

// API: Analyze selected events with LLM
app.post('/api/analyze', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }
    const { keys, model, apiKey, prompt } = req.body;

    if (!keys || !Array.isArray(keys) || keys.length === 0) {
      return res.status(400).json({ error: 'No events selected' });
    }

    if (!apiKey) {
      return res.status(400).json({ error: 'Anthropic API key required' });
    }

    // Retrieve selected events from database
    const placeholders = keys.map(() => '?').join(',');
    const events = db.prepare(`
      SELECT data FROM entries
      WHERE key IN (${placeholders})
      ORDER BY ts ASC
    `).all(...keys);

    if (events.length === 0) {
      return res.status(404).json({ error: 'No events found' });
    }

    // Parse events
    const parsedEvents = events.map(row => JSON.parse(row.data));

    // Format events for LLM
    const eventsText = parsedEvents.map((e, i) => {
      return `Event ${i + 1}:
- Time: ${e.ts}
- Type: ${e.event}
- Runner: ${e.runner}
- Tool: ${e.data?.tool || 'N/A'}
- Status: ${e.data?.status || 'N/A'}
- Duration: ${e.data?.durationMs ? `${e.data.durationMs}ms` : 'N/A'}
- Args: ${JSON.stringify(e.data?.args || {}, null, 2)}`;
    }).join('\n\n');

    // Prepare LLM request
    const systemPrompt = prompt || `You are an AI agent behavior analyst. Analyze the following sequence of agent tool executions and provide insights about:
1. What the agent was trying to accomplish
2. Efficiency and performance patterns
3. Any potential issues or improvements
4. Overall workflow assessment

Be concise and actionable.`;

    const userMessage = `Analyze these ${parsedEvents.length} agent events:\n\n${eventsText}`;

    // Call Anthropic API
    const analysis = await callAnthropicAPI(model || 'claude-sonnet-4-6', systemPrompt, userMessage, apiKey);

    // Save analysis to database
    const analysisId = db.prepare(`
      INSERT INTO analyses (timestamp, model, event_count, event_keys, analysis, prompt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      model || 'claude-sonnet-4-6',
      parsedEvents.length,
      JSON.stringify(keys),
      analysis,
      prompt || null
    ).lastInsertRowid;

    res.json({
      success: true,
      analysis,
      eventCount: parsedEvents.length,
      model: model || 'claude-sonnet-4-6',
      provider: 'anthropic',
      analysisId
    });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Save selected events for MCP bridge (CLI analysis)
app.post('/api/selection', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }
    const { keys } = req.body;

    if (!keys || !Array.isArray(keys) || keys.length === 0) {
      return res.status(400).json({ error: 'No event keys provided' });
    }

    // Fetch full event data for the selected keys
    const placeholders = keys.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT key, data FROM entries
      WHERE key IN (${placeholders})
      ORDER BY ts ASC
    `).all(...keys);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No events found for the provided keys' });
    }

    const events = rows.map(row => {
      const cepEvent = JSON.parse(row.data);
      decodeBase64Fields(cepEvent);
      return { __key: row.key, ...cepEvent };
    });

    const selection = {
      timestamp: new Date().toISOString(),
      count: events.length,
      events
    };

    // Write to selection.json next to the database file
    const selectionPath = path.join(path.dirname(dbPath), 'selection.json');
    fs.writeFileSync(selectionPath, JSON.stringify(selection, null, 2));

    res.json({ success: true, count: events.length });
  } catch (error) {
    console.error('Save selection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get current selection
app.get('/api/selection', (req, res) => {
  try {
    const selectionPath = path.join(path.dirname(dbPath), 'selection.json');

    if (!fs.existsSync(selectionPath)) {
      return res.json({ timestamp: null, count: 0, events: [] });
    }

    const data = JSON.parse(fs.readFileSync(selectionPath, 'utf-8'));
    res.json(data);
  } catch (error) {
    console.error('Get selection error:', error);
    res.status(500).json({ error: error.message });
  }
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

// API: Get tags for entries
app.get('/api/tags', (req, res) => {
  try {
    const tags = db.prepare('SELECT entry_key, tag FROM tags').all();

    const tagsByKey = {};
    for (const row of tags) {
      if (!tagsByKey[row.entry_key]) {
        tagsByKey[row.entry_key] = [];
      }
      tagsByKey[row.entry_key].push(row.tag);
    }

    res.json(tagsByKey);
  } catch (error) {
    console.error('Get tags error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Add/remove tag
app.post('/api/tags', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }
    const { entryKey, tag, action } = req.body;

    if (action === 'add') {
      db.prepare('INSERT OR IGNORE INTO tags (entry_key, tag) VALUES (?, ?)').run(entryKey, tag);
    } else if (action === 'remove') {
      db.prepare('DELETE FROM tags WHERE entry_key = ? AND tag = ?').run(entryKey, tag);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Tag operation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get notes
app.get('/api/notes', (req, res) => {
  try {
    const notes = db.prepare('SELECT entry_key, note FROM notes').all();

    const notesByKey = {};
    for (const row of notes) {
      notesByKey[row.entry_key] = row.note;
    }

    res.json(notesByKey);
  } catch (error) {
    console.error('Get notes error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Set note
app.post('/api/notes', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }
    const { entryKey, note } = req.body;

    if (note && note.trim()) {
      db.prepare('INSERT OR REPLACE INTO notes (entry_key, note) VALUES (?, ?)').run(entryKey, note);
    } else {
      db.prepare('DELETE FROM notes WHERE entry_key = ?').run(entryKey);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Note operation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Export tags and notes
app.get('/api/export', (req, res) => {
  try {
    const tags = db.prepare('SELECT entry_key, tag FROM tags').all();
    const notes = db.prepare('SELECT entry_key, note FROM notes').all();

    const tagsByKey = {};
    for (const row of tags) {
      if (!tagsByKey[row.entry_key]) {
        tagsByKey[row.entry_key] = [];
      }
      tagsByKey[row.entry_key].push(row.tag);
    }

    const notesByKey = {};
    for (const row of notes) {
      notesByKey[row.entry_key] = row.note;
    }

    res.json({
      exportedAt: new Date().toISOString(),
      tagsByKey,
      notesByKey
    });
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Import tags and notes
app.post('/api/import', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const { tagsByKey, notesByKey } = req.body;

    // Validate structure before touching the database
    if (tagsByKey != null) {
      if (typeof tagsByKey !== 'object' || Array.isArray(tagsByKey)) {
        return res.status(400).json({ error: 'tagsByKey must be an object' });
      }
      for (const [key, tags] of Object.entries(tagsByKey)) {
        if (!Array.isArray(tags)) {
          return res.status(400).json({ error: `tagsByKey["${key}"] must be an array` });
        }
        for (const tag of tags) {
          if (typeof tag !== 'string') {
            return res.status(400).json({ error: `tagsByKey["${key}"] contains a non-string value` });
          }
        }
      }
    }
    if (notesByKey != null) {
      if (typeof notesByKey !== 'object' || Array.isArray(notesByKey)) {
        return res.status(400).json({ error: 'notesByKey must be an object' });
      }
      for (const [key, note] of Object.entries(notesByKey)) {
        if (typeof note !== 'string') {
          return res.status(400).json({ error: `notesByKey["${key}"] must be a string` });
        }
      }
    }

    // Atomic replace: delete + insert in a single transaction
    const insertTag = db.prepare('INSERT OR IGNORE INTO tags (entry_key, tag) VALUES (?, ?)');
    const insertNote = db.prepare('INSERT OR REPLACE INTO notes (entry_key, note) VALUES (?, ?)');

    const importAll = db.transaction(() => {
      db.exec('DELETE FROM tags');
      db.exec('DELETE FROM notes');

      if (tagsByKey) {
        for (const [key, tags] of Object.entries(tagsByKey)) {
          for (const tag of tags) {
            insertTag.run(key, tag);
          }
        }
      }

      if (notesByKey) {
        for (const [key, note] of Object.entries(notesByKey)) {
          insertNote.run(key, note);
        }
      }
    });

    importAll();

    res.json({ success: true });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Database: ${dbPath}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nClosing database...');
  db.close();
  process.exit(0);
});
