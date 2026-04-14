const Database = require('better-sqlite3');

function initDatabase({ dbPath, logger }) {
  const db = new Database(dbPath);

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

    PRAGMA table_info(entries);
  `);

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN runner TEXT`);
    logger.debug('Added column: runner');
  } catch (e) {}

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN event TEXT`);
    logger.debug('Added column: event');
  } catch (e) {}

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN traceId TEXT`);
    logger.debug('Added column: traceId');
  } catch (e) {}

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN status TEXT`);
    logger.debug('Added column: status');
  } catch (e) {}

  try {
    db.exec(`ALTER TABLE entries ADD COLUMN agentId TEXT`);
    logger.debug('Added column: agentId');
  } catch (e) {}

  try {
    db.exec(`ALTER TABLE task_runs ADD COLUMN estimated_cost_known INTEGER NOT NULL DEFAULT 0`);
    logger.debug('Added column: estimated_cost_known');
  } catch (e) {}

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
      estimated_cost_known INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS task_run_reports (
      task_run_id INTEGER PRIMARY KEY,
      report_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      report_version TEXT NOT NULL DEFAULT '1',
      based_on_outcome_id INTEGER,
      based_on_task_run_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS review_acknowledgements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_from TEXT NOT NULL,
      period_to TEXT NOT NULL,
      runner TEXT,
      reviewer TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_review_ack_period ON review_acknowledgements(period_from, period_to);
    CREATE INDEX IF NOT EXISTS idx_review_ack_runner ON review_acknowledgements(runner);
    CREATE INDEX IF NOT EXISTS idx_review_ack_acknowledged_at ON review_acknowledgements(acknowledged_at);

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
  return db;
}

module.exports = {
  initDatabase
};
