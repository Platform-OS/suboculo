const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { insertCEPEvent, insertCEPEventsBatch, validateCEPEvent } = require('./cep-processor');
const EventEmitter = require('events');
const logger = require('./logger');

const app = express();
const PORT = process.env.SUBOCULO_PORT || 3000;
const HOST = process.env.SUBOCULO_HOST || '127.0.0.1';
const OUTCOME_LABELS = [
  'success',
  'partial_success',
  'failure',
  'unsafe_success',
  'interrupted',
  'abandoned',
  'unknown'
];
const EVALUATION_TYPES = [
  'human',
  'rule_based',
  'llm_judge',
  'benchmark_checker'
];
const FAILURE_TAXONOMY = {
  planning_failure: [
    'missing_plan',
    'wrong_plan',
    'incomplete_plan'
  ],
  execution_failure: [
    'wrong_edit',
    'incomplete_edit',
    'regression_introduced'
  ],
  tooling_failure: [
    'tool_error',
    'tool_unavailable',
    'tool_timeout'
  ],
  environment_failure: [
    'dependency_missing',
    'sandbox_restriction',
    'external_service_unavailable'
  ],
  safety_violation: [
    'policy_violation',
    'unsafe_command',
    'sensitive_data_exposure'
  ],
  validation_failure: [
    'tests_failed',
    'lint_failed',
    'manual_check_failed'
  ],
  interruption: [
    'user_interrupt',
    'process_killed',
    'context_limit'
  ],
  abandonment: [
    'gave_up',
    'no_progress',
    'deferred_without_resolution'
  ],
  unknown_failure: [
    'insufficient_evidence'
  ]
};
const FAILURE_MODES = Object.keys(FAILURE_TAXONOMY);
const OUTCOME_LABELS_REQUIRING_FAILURE_MODE = new Set([
  'failure',
  'unsafe_success',
  'interrupted',
  'abandoned'
]);
const ATTEMPT_IDLE_GAP_MS = 45 * 60 * 1000;
const gitRevisionCache = new Map();

// SSE Event Emitter for real-time updates
const sseEmitter = new EventEmitter();
sseEmitter.setMaxListeners(100); // Support up to 100 concurrent SSE connections

// Middleware
app.use(express.json({ limit: '10mb' }));

// Serve static frontend files
const frontendPath = path.join(__dirname, '../frontend');
logger.debug('[suboculo] Checking frontend path:', frontendPath);
logger.debug('[suboculo] Frontend exists?', fs.existsSync(frontendPath));
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
  logger.info('[suboculo] Static files enabled from:', frontendPath);
} else {
  logger.warn('[suboculo] Frontend not found - web UI unavailable');
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
    logger.debug('Added column: runner');
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN event TEXT`);
    logger.debug('Added column: event');
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN traceId TEXT`);
    logger.debug('Added column: traceId');
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN status TEXT`);
    logger.debug('Added column: status');
  } catch (e) {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN agentId TEXT`);
    logger.debug('Added column: agentId');
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

  logger.info('Database initialized');
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

function buildTaskRunsWhereClause(query = {}, taskRunsAlias = 'task_runs') {
  const {
    runner,
    status,
    source,
    from,
    to,
    query: textQuery,
    canonical_outcome_label,
    failure_mode,
    failure_subtype,
    requires_human_intervention,
    has_canonical_outcome
  } = query;

  const where = ['1=1'];
  const params = [];

  if (runner && runner !== 'all') {
    where.push(`${taskRunsAlias}.runner = ?`);
    params.push(runner);
  }
  if (status && status !== 'all') {
    where.push(`${taskRunsAlias}.status = ?`);
    params.push(status);
  }
  if (source && source !== 'all') {
    where.push(`${taskRunsAlias}.source = ?`);
    params.push(source);
  }
  if (from) {
    where.push(`${taskRunsAlias}.started_at >= ?`);
    params.push(from);
  }
  if (to) {
    where.push(`${taskRunsAlias}.started_at <= ?`);
    params.push(to);
  }
  if (textQuery) {
    where.push(`(${taskRunsAlias}.task_key LIKE ? OR ${taskRunsAlias}.title LIKE ? OR ${taskRunsAlias}.description LIKE ? OR ${taskRunsAlias}.root_session_id LIKE ?)`);
    const like = `%${textQuery}%`;
    params.push(like, like, like, like);
  }

  if (has_canonical_outcome === 'true') {
    where.push(`EXISTS (
      SELECT 1 FROM outcomes o
      WHERE o.task_run_id = ${taskRunsAlias}.id
        AND o.is_canonical = 1
    )`);
  } else if (has_canonical_outcome === 'false') {
    where.push(`NOT EXISTS (
      SELECT 1 FROM outcomes o
      WHERE o.task_run_id = ${taskRunsAlias}.id
        AND o.is_canonical = 1
    )`);
  }

  if (canonical_outcome_label && canonical_outcome_label !== 'all') {
    if (canonical_outcome_label === 'none') {
      where.push(`NOT EXISTS (
        SELECT 1 FROM outcomes o
        WHERE o.task_run_id = ${taskRunsAlias}.id
          AND o.is_canonical = 1
      )`);
    } else {
      where.push(`EXISTS (
        SELECT 1 FROM outcomes o
        WHERE o.task_run_id = ${taskRunsAlias}.id
          AND o.is_canonical = 1
          AND o.outcome_label = ?
      )`);
      params.push(canonical_outcome_label);
    }
  }

  if (failure_mode && failure_mode !== 'all') {
    where.push(`EXISTS (
      SELECT 1 FROM outcomes o
      WHERE o.task_run_id = ${taskRunsAlias}.id
        AND o.is_canonical = 1
        AND o.failure_mode = ?
    )`);
    params.push(failure_mode);
  }

  if (failure_subtype && failure_subtype !== 'all') {
    where.push(`EXISTS (
      SELECT 1 FROM outcomes o
      WHERE o.task_run_id = ${taskRunsAlias}.id
        AND o.is_canonical = 1
        AND o.failure_subtype = ?
    )`);
    params.push(failure_subtype);
  }

  if (requires_human_intervention === 'true') {
    where.push(`EXISTS (
      SELECT 1 FROM outcomes o
      WHERE o.task_run_id = ${taskRunsAlias}.id
        AND o.is_canonical = 1
        AND o.requires_human_intervention = 1
    )`);
  } else if (requires_human_intervention === 'false') {
    where.push(`EXISTS (
      SELECT 1 FROM outcomes o
      WHERE o.task_run_id = ${taskRunsAlias}.id
        AND o.is_canonical = 1
        AND o.requires_human_intervention = 0
    )`);
  }

  return {
    whereSql: where.join(' AND '),
    params
  };
}

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
    const day = date.getUTCDay(); // Sunday=0
    const mondayOffset = (day + 6) % 7;
    const mondayDate = new Date(Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() - mondayOffset,
      0, 0, 0, 0
    ));
    return mondayDate;
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
  if (bucket === 'week') {
    end.setUTCDate(end.getUTCDate() + 7);
  } else {
    end.setUTCDate(end.getUTCDate() + 1);
  }
  return end;
}

function createTrendBucket(startDate) {
  return {
    bucket_start: startDate.toISOString(),
    bucket_end: null,
    task_runs: 0,
    with_canonical_outcome: 0,
    success_count: 0,
    partial_success_count: 0,
    failure_count: 0,
    unsafe_success_count: 0,
    retry_runs: 0,
    total_estimated_cost: 0,
    successful_estimated_cost: 0
  };
}

function ratioOrNull(numerator, denominator) {
  if (!denominator) return null;
  return +(numerator / denominator).toFixed(6);
}

function finalizeTrendBucket(bucket) {
  const withCanonical = bucket.with_canonical_outcome;
  const success = bucket.success_count;
  return {
    bucket_start: bucket.bucket_start,
    bucket_end: bucket.bucket_end,
    task_runs: bucket.task_runs,
    with_canonical_outcome: withCanonical,
    success_count: success,
    partial_success_count: bucket.partial_success_count,
    failure_count: bucket.failure_count,
    unsafe_success_count: bucket.unsafe_success_count,
    retry_runs: bucket.retry_runs,
    total_estimated_cost: +bucket.total_estimated_cost.toFixed(6),
    successful_estimated_cost: +bucket.successful_estimated_cost.toFixed(6),
    success_rate: ratioOrNull(success, withCanonical),
    partial_success_rate: ratioOrNull(bucket.partial_success_count, withCanonical),
    failure_rate: ratioOrNull(bucket.failure_count, withCanonical),
    retry_rate: ratioOrNull(bucket.retry_runs, bucket.task_runs),
    cost_per_success: ratioOrNull(bucket.successful_estimated_cost, success)
  };
}

function summarizeReliabilityKpis(rows) {
  const totalRuns = rows.length;
  const withCanonical = rows.filter(r => !!r.canonical_outcome_label);
  const successfulRuns = withCanonical.filter(r => r.canonical_outcome_label === 'success');
  const unsafeSuccessRuns = withCanonical.filter(r => r.canonical_outcome_label === 'unsafe_success');
  const retryRuns = rows.filter(r => (r.retry_count || 0) > 0);
  const firstPassSuccessRuns = successfulRuns.filter(r => (r.retry_count || 0) === 0);
  const interventionRuns = withCanonical.filter(r => Number(r.canonical_requires_human_intervention) === 1);

  const totalCost = rows.reduce((sum, r) => sum + (r.estimated_cost || 0), 0);
  const successfulCost = successfulRuns.reduce((sum, r) => sum + (r.estimated_cost || 0), 0);

  const durations = rows
    .map(r => r.total_duration_ms)
    .filter(v => typeof v === 'number' && Number.isFinite(v));

  const tokenInputTotal = rows.reduce((sum, r) => sum + (r.token_input || 0), 0);
  const tokenOutputTotal = rows.reduce((sum, r) => sum + (r.token_output || 0), 0);
  const tokenCacheCreationTotal = rows.reduce((sum, r) => sum + (r.token_cache_creation || 0), 0);
  const tokenCacheReadTotal = rows.reduce((sum, r) => sum + (r.token_cache_read || 0), 0);

  const ratio = (numerator, denominator) => (denominator > 0 ? +(numerator / denominator).toFixed(6) : null);

  return {
    counts: {
      task_runs: totalRuns,
      with_canonical_outcome: withCanonical.length,
      successful_runs: successfulRuns.length,
      unsafe_success_runs: unsafeSuccessRuns.length,
      retry_runs: retryRuns.length,
      first_pass_success_runs: firstPassSuccessRuns.length,
      intervention_runs: interventionRuns.length
    },
    rates: {
      success_rate: ratio(successfulRuns.length, withCanonical.length),
      unsafe_success_rate: ratio(unsafeSuccessRuns.length, withCanonical.length),
      first_pass_rate: ratio(firstPassSuccessRuns.length, withCanonical.length),
      retry_rate: ratio(retryRuns.length, totalRuns),
      intervention_rate: ratio(interventionRuns.length, withCanonical.length)
    },
    cost: {
      total_estimated_cost: +totalCost.toFixed(6),
      successful_estimated_cost: +successfulCost.toFixed(6),
      cost_per_success: ratio(successfulCost, successfulRuns.length)
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
      input_per_run: ratio(tokenInputTotal, totalRuns),
      output_per_run: ratio(tokenOutputTotal, totalRuns)
    }
  };
}

function normalizeModelName(model) {
  if (!model || typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  return trimmed.replace(/-\d{8}$/u, '');
}

function resolveGitRevision(directoryPath) {
  if (!directoryPath || typeof directoryPath !== 'string') return null;
  if (gitRevisionCache.has(directoryPath)) return gitRevisionCache.get(directoryPath);

  let revision = null;
  try {
    revision = execFileSync('git', ['-C', directoryPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null;
  } catch {
    revision = null;
  }

  gitRevisionCache.set(directoryPath, revision);
  return revision;
}

function deriveProvenance(parsedEvents, usageRows, sessionStart, firstEvent) {
  const modelCandidates = [
    ...usageRows.map(event => event?.data?.model).filter(Boolean),
    ...parsedEvents.map(event => event?.data?.model).filter(Boolean)
  ];
  const rawModel = modelCandidates.length ? modelCandidates[modelCandidates.length - 1] : null;
  const model = normalizeModelName(rawModel);

  const runnerVersionCandidates = [
    sessionStart?.data?.runnerVersion,
    sessionStart?.data?.version,
    sessionStart?.data?.cliVersion,
    sessionStart?.data?.claudeCodeVersion,
    sessionStart?.data?.opencodeVersion,
    ...parsedEvents.map(event =>
      event?.data?.runnerVersion ||
      event?.data?.version ||
      event?.data?.cliVersion ||
      event?.data?.claudeCodeVersion ||
      event?.data?.opencodeVersion ||
      null
    ).filter(Boolean)
  ].filter(Boolean);
  const runnerVersion = runnerVersionCandidates.length
    ? String(runnerVersionCandidates[runnerVersionCandidates.length - 1])
    : null;

  const directory = sessionStart?.data?.directory || firstEvent?.data?.directory || null;
  const gitRevision = resolveGitRevision(directory);

  return {
    model,
    rawModel: rawModel || null,
    runnerVersion,
    gitRevision
  };
}

function deriveTaskRunStatus(rows) {
  const endRows = rows.filter(row => row.event === 'session.end');
  if (endRows.length > 0) {
    const lastEnd = parseJSONSafe(endRows[endRows.length - 1].data, {});
    const reason = lastEnd?.data?.reason;
    if (reason === 'cancelled' || reason === 'user_cancelled') return 'cancelled';
    if (reason === 'timeout' || reason === 'timed_out') return 'timed_out';
    if (reason === 'error' || reason === 'failed' || reason === 'failure') return 'failed';
    return 'completed';
  }

  // Without an explicit session end, treat the run as still active.
  // This avoids marking long-lived/reused sessions as completed.
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
  const provenance = deriveProvenance(parsed, usageRows, sessionStart, first);

  return {
    title,
    description,
    runner: first.runner || null,
    model: provenance.model,
    agentSystemVersion: provenance.runnerVersion,
    toolchainVersion: provenance.runnerVersion,
    gitRevision: provenance.gitRevision,
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
      tools: [...distinctTools],
      modelRaw: provenance.rawModel,
      runnerVersion: provenance.runnerVersion
    })
  };
}

function splitRowsIntoAttemptRuns(rows) {
  if (!rows.length) return [];

  const attempts = [];
  let current = [];
  let prevTsMs = null;
  let prevEvent = null;

  for (const row of rows) {
    // Ignore malformed session.start events without a concrete session identity.
    // They should not create attempt boundaries.
    const isSessionStart = row.event === 'session.start' && !!row.sessionID;
    const rowTsMs = row.ts ? Date.parse(row.ts) : NaN;
    const gapExceeded = Number.isFinite(prevTsMs) && Number.isFinite(rowTsMs)
      ? (rowTsMs - prevTsMs > ATTEMPT_IDLE_GAP_MS)
      : false;
    const startsAfterEnd = prevEvent === 'session.end';

    if (current.length > 0 && (isSessionStart || gapExceeded || startsAfterEnd)) {
      attempts.push(current);
      current = [];
    }

    current.push(row);
    prevTsMs = Number.isFinite(rowTsMs) ? rowTsMs : prevTsMs;
    prevEvent = row.event || null;
  }

  if (current.length > 0) {
    attempts.push(current);
  }

  return attempts;
}

function upsertTaskRunForRootSession(rootSessionId) {
  if (!rootSessionId) return [];

  const rows = db.prepare(`
    SELECT key, ts, sessionID, rootSessionID, runner, event, data
    FROM entries
    WHERE rootSessionID = ? OR sessionID = ?
    ORDER BY ts ASC, id ASC
  `).all(rootSessionId, rootSessionId);

  if (rows.length === 0) return [];
  const attempts = splitRowsIntoAttemptRuns(rows);

  const upsert = db.prepare(`
    INSERT INTO task_runs (
      task_key, title, description, source, runner, model, agent_system_version, toolchain_version, git_revision, status, root_session_id,
      started_at, ended_at, total_events, total_tool_calls, distinct_tools,
      total_duration_ms, error_count, retry_count, subagent_count, interrupt_count,
      token_input, token_output, token_cache_creation, token_cache_read,
      estimated_cost, metadata, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_key) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      source = excluded.source,
      runner = excluded.runner,
      model = excluded.model,
      agent_system_version = excluded.agent_system_version,
      toolchain_version = excluded.toolchain_version,
      git_revision = excluded.git_revision,
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

  const taskRunIds = [];
  attempts.forEach((attemptRows, idx) => {
    const summary = summarizeTaskRunRows(attemptRows);
    const taskKey = `root:${rootSessionId}::attempt:${idx + 1}`;

    upsert.run(
      taskKey,
      summary.title,
      summary.description,
      'derived_attempt',
      summary.runner,
      summary.model,
      summary.agentSystemVersion,
      summary.toolchainVersion,
      summary.gitRevision,
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

    const taskRun = db.prepare('SELECT id FROM task_runs WHERE task_key = ?').get(taskKey);
    if (!taskRun?.id) return;
    replaceLinks(taskRun.id, attemptRows);
    taskRunIds.push(taskRun.id);
  });

  return taskRunIds;
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
    const taskRunIds = upsertTaskRunForRootSession(row.rootSessionId);
    derived += taskRunIds.length;
  }
  return derived;
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
    logger.error('Batch notify error:', error);
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
    logger.error('Batch ingest error:', error);
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

app.get('/api/reliability/kpis', (req, res) => {
  try {
    const { whereSql, params } = buildTaskRunsWhereClause(req.query, 'tr');

    const rows = db.prepare(`
      SELECT
        tr.id,
        tr.retry_count,
        tr.estimated_cost,
        tr.total_duration_ms,
        tr.token_input,
        tr.token_output,
        tr.token_cache_creation,
        tr.token_cache_read,
        (
          SELECT o.outcome_label
          FROM outcomes o
          WHERE o.task_run_id = tr.id
            AND o.is_canonical = 1
          ORDER BY o.evaluated_at DESC, o.id DESC
          LIMIT 1
        ) AS canonical_outcome_label,
        (
          SELECT o.requires_human_intervention
          FROM outcomes o
          WHERE o.task_run_id = tr.id
            AND o.is_canonical = 1
          ORDER BY o.evaluated_at DESC, o.id DESC
          LIMIT 1
        ) AS canonical_requires_human_intervention
      FROM task_runs tr
      WHERE ${whereSql}
    `).all(...params);

    res.json(summarizeReliabilityKpis(rows));
  } catch (error) {
    console.error('Reliability KPI error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reliability/kpis/by-runner', (req, res) => {
  try {
    const { whereSql, params } = buildTaskRunsWhereClause(req.query, 'tr');

    const rows = db.prepare(`
      SELECT
        tr.id,
        tr.runner,
        tr.retry_count,
        tr.estimated_cost,
        tr.total_duration_ms,
        tr.token_input,
        tr.token_output,
        tr.token_cache_creation,
        tr.token_cache_read,
        (
          SELECT o.outcome_label
          FROM outcomes o
          WHERE o.task_run_id = tr.id
            AND o.is_canonical = 1
          ORDER BY o.evaluated_at DESC, o.id DESC
          LIMIT 1
        ) AS canonical_outcome_label,
        (
          SELECT o.requires_human_intervention
          FROM outcomes o
          WHERE o.task_run_id = tr.id
            AND o.is_canonical = 1
          ORDER BY o.evaluated_at DESC, o.id DESC
          LIMIT 1
        ) AS canonical_requires_human_intervention
      FROM task_runs tr
      WHERE ${whereSql}
    `).all(...params);

    const byRunnerMap = new Map();
    for (const row of rows) {
      const runner = row.runner || 'unknown';
      if (!byRunnerMap.has(runner)) byRunnerMap.set(runner, []);
      byRunnerMap.get(runner).push(row);
    }

    const by_runner = [...byRunnerMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([runner, runnerRows]) => ({
        runner,
        ...summarizeReliabilityKpis(runnerRows)
      }));

    res.json({
      total_runners: by_runner.length,
      by_runner
    });
  } catch (error) {
    console.error('Reliability KPI by-runner error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reliability/trends', (req, res) => {
  try {
    const bucket = req.query.bucket === 'week' ? 'week' : 'day';
    const parsedWindowDays = Number.parseInt(String(req.query.window_days || ''), 10);
    const windowDays = Number.isFinite(parsedWindowDays) && parsedWindowDays > 0 ? parsedWindowDays : 30;

    const scopedQuery = { ...req.query };
    if (!scopedQuery.from && !scopedQuery.to) {
      scopedQuery.from = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    }

    const { whereSql, params } = buildTaskRunsWhereClause(scopedQuery, 'tr');

    const rows = db.prepare(`
      SELECT
        tr.id,
        tr.runner,
        tr.started_at,
        tr.retry_count,
        tr.estimated_cost,
        (
          SELECT o.outcome_label
          FROM outcomes o
          WHERE o.task_run_id = tr.id
            AND o.is_canonical = 1
          ORDER BY o.evaluated_at DESC, o.id DESC
          LIMIT 1
        ) AS canonical_outcome_label
      FROM task_runs tr
      WHERE ${whereSql}
        AND tr.started_at IS NOT NULL
      ORDER BY tr.started_at ASC
    `).all(...params);

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
      for (const target of targets) {
        target.task_runs += 1;
        target.total_estimated_cost += row.estimated_cost || 0;
        if ((row.retry_count || 0) > 0) target.retry_runs += 1;

        const label = row.canonical_outcome_label;
        if (label) {
          target.with_canonical_outcome += 1;
          if (label === 'success') {
            target.success_count += 1;
            target.successful_estimated_cost += row.estimated_cost || 0;
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

    res.json({
      bucket,
      window_days: windowDays,
      from: scopedQuery.from || null,
      to: scopedQuery.to || null,
      series,
      by_runner
    });
  } catch (error) {
    console.error('Reliability trends error:', error);
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
    if (!EVALUATION_TYPES.includes(evaluation_type)) {
      return res.status(400).json({
        error: 'Invalid evaluation_type',
        allowed: EVALUATION_TYPES
      });
    }
    if (!OUTCOME_LABELS.includes(outcome_label)) {
      return res.status(400).json({
        error: 'Invalid outcome_label',
        allowed: OUTCOME_LABELS
      });
    }

    const normalizedFailureMode = normalizeOptionalString(failure_mode);
    const normalizedFailureSubtype = normalizeOptionalString(failure_subtype);
    const requiresFailureMode = OUTCOME_LABELS_REQUIRING_FAILURE_MODE.has(outcome_label);

    if (requiresFailureMode && !normalizedFailureMode) {
      return res.status(400).json({
        error: 'failure_mode is required for this outcome_label',
        outcome_label,
        required_for: [...OUTCOME_LABELS_REQUIRING_FAILURE_MODE]
      });
    }
    if (normalizedFailureMode && !FAILURE_MODES.includes(normalizedFailureMode)) {
      return res.status(400).json({
        error: 'Invalid failure_mode',
        allowed: FAILURE_MODES
      });
    }
    if (normalizedFailureSubtype && !normalizedFailureMode) {
      return res.status(400).json({
        error: 'failure_subtype requires failure_mode'
      });
    }
    if (normalizedFailureMode && normalizedFailureSubtype) {
      const allowedSubtypes = FAILURE_TAXONOMY[normalizedFailureMode] || [];
      if (!allowedSubtypes.includes(normalizedFailureSubtype)) {
        return res.status(400).json({
          error: 'Invalid failure_subtype for failure_mode',
          failure_mode: normalizedFailureMode,
          allowed: allowedSubtypes
        });
      }
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
        normalizedFailureMode,
        normalizedFailureSubtype,
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
      event,
      attempt
    } = req.query;

    let sql = `
      SELECT
        e.*,
        tr.id AS taskRunId,
        tr.task_key AS attemptKey
      FROM entries e
      LEFT JOIN task_run_events tre ON tre.entry_key = e.key
      LEFT JOIN task_runs tr ON tr.id = tre.task_run_id
      WHERE 1=1
    `;
    const params = [];

    // Apply CEP filters
    if (runner && runner !== 'all') {
      sql += ' AND e.runner = ?';
      params.push(runner);
    }

    if (event && event !== 'all') {
      sql += ' AND e.event = ?';
      params.push(event);
    }

    if (attempt && attempt !== 'all') {
      sql += ' AND tr.task_key = ?';
      params.push(attempt);
    }

    // Apply legacy filters (backward compat)
    if (kind && kind !== 'all') {
      sql += ' AND (e.kind = ? OR e.event = ?)';
      params.push(kind, kind);
    }

    if (type && type !== 'all') {
      sql += ' AND e.type = ?';
      params.push(type);
    }

    if (tool && tool !== 'all') {
      sql += ' AND e.tool = ?';
      params.push(tool);
    }

    if (subagent && subagent !== 'all') {
      sql += ' AND e.subagentType = ?';
      params.push(subagent);
    }

    if (rootSession && rootSession !== 'all') {
      sql += ' AND e.rootSessionID = ?';
      params.push(rootSession);
    }

    if (tag && tag !== 'all') {
      sql += ' AND e.key IN (SELECT entry_key FROM tags WHERE tag = ?)';
      params.push(tag);
    }

    if (query) {
      sql += ` AND (
        e.kind LIKE ? OR
        e.type LIKE ? OR
        e.tool LIKE ? OR
        e.sessionID LIKE ? OR
        e.rootSessionID LIKE ? OR
        e.callID LIKE ? OR
        e.title LIKE ? OR
        e.outputPreview LIKE ? OR
        e.args LIKE ? OR
        tr.task_key LIKE ? OR
        e.key IN (SELECT entry_key FROM tags WHERE tag LIKE ?) OR
        e.key IN (SELECT entry_key FROM notes WHERE note LIKE ?)
      )`;
      const likeQuery = `%${query}%`;
      params.push(...Array(12).fill(likeQuery));
    }

    // Count total matching
    const countSql = sql.replace(
      `SELECT
        e.*,
        tr.id AS taskRunId,
        tr.task_key AS attemptKey`,
      'SELECT COUNT(DISTINCT e.key) as count'
    );
    const countResult = db.prepare(countSql).get(...params);
    const total = countResult.count;

    // Add sorting
    const allowedSortKeys = ['ts', 'kind', 'tool', 'durationMs'];
    const safeSortKey = allowedSortKeys.includes(sortKey) ? sortKey : 'ts';
    const safeSortDir = sortDir === 'asc' ? 'ASC' : 'DESC';
    sql += ` GROUP BY e.key ORDER BY e.${safeSortKey} ${safeSortDir}`;

    // Add pagination
    const limit = parseInt(pageSize);
    const offset = (parseInt(page) - 1) * limit;
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    // Execute query
    const entries = db.prepare(sql).all(...params);

    // Return clean CEP events, supplementing with DB column values
    const parsedEntries = entries.map(row => {
      const cepEvent = tryParseJson(row.data);
      if (!cepEvent) return null;

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
        taskRunId: row.taskRunId || null,
        attemptKey: row.attemptKey || null,
        ...cepEvent
      };
    }).filter(Boolean);

    res.json({
      entries: parsedEntries,
      total,
      page: parseInt(page),
      pageSize: limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    logger.error('Query error:', error);
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
    const attempts = db.prepare(`
      SELECT DISTINCT task_key
      FROM task_runs
      WHERE source = 'derived_attempt'
      ORDER BY started_at DESC, task_key DESC
    `).all();

    res.json({
      kinds: kinds.map(r => r.kind),
      types: types.map(r => r.type),
      tools: tools.map(r => r.tool),
      subagents: subagents.map(r => r.subagentType),
      roots: roots.map(r => r.rootSessionID),
      allTags: allTags.map(r => r.tag),
      runners: runners.map(r => r.runner),
      events: events.map(r => r.event),
      attempts: attempts.map(r => r.task_key)
    });
  } catch (error) {
    logger.error('Facets error:', error);
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
    logger.error('Stats error:', error);
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
    logger.error('Get analyses error:', error);
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

    analysis.event_keys = tryParseJson(analysis.event_keys);
    if (!analysis.event_keys) {
      return res.status(500).json({ error: 'Failed to parse saved analysis event keys' });
    }
    res.json(analysis);
  } catch (error) {
    logger.error('Get analysis error:', error);
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
    logger.error('Save analysis error:', error);
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
    logger.error('Delete analysis error:', error);
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
    const parsedEvents = events
      .map(row => tryParseJson(row.data))
      .filter(Boolean);

    if (parsedEvents.length === 0) {
      return res.status(500).json({ error: 'Failed to parse selected events' });
    }

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
    logger.error('Analysis error:', error);
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
      const cepEvent = tryParseJson(row.data);
      if (!cepEvent) return null;
      decodeBase64Fields(cepEvent);
      return { __key: row.key, ...cepEvent };
    }).filter(Boolean);

    if (events.length === 0) {
      return res.status(500).json({ error: 'Failed to parse selected event data' });
    }

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
    logger.error('Save selection error:', error);
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

    const data = tryParseJson(fs.readFileSync(selectionPath, 'utf-8'));
    if (!data) {
      return res.status(500).json({ error: 'Failed to parse selection file' });
    }
    res.json(data);
  } catch (error) {
    logger.error('Get selection error:', error);
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
    logger.error('Get tags error:', error);
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
    logger.error('Tag operation error:', error);
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
    logger.error('Get notes error:', error);
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
    logger.error('Note operation error:', error);
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
    logger.error('Export error:', error);
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
    logger.error('Import error:', error);
    res.status(500).json({ error: error.message });
  }
});

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
