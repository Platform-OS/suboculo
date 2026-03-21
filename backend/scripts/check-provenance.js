#!/usr/bin/env node

const path = require('path');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const args = {
    dbPath: process.env.SUBOCULO_DB_PATH || path.join(__dirname, '..', 'events.db'),
    hours: Number(process.env.SUBOCULO_PROVENANCE_WINDOW_HOURS || 72),
    runners: (process.env.SUBOCULO_PROVENANCE_RUNNERS || 'claude-code,opencode')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean),
    strictTaskRuns: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      return args;
    }
    if (arg === '--strict-task-runs') {
      args.strictTaskRuns = true;
      continue;
    }
    if (arg === '--db' && argv[i + 1]) {
      args.dbPath = argv[++i];
      continue;
    }
    if (arg === '--hours' && argv[i + 1]) {
      args.hours = Number(argv[++i]);
      continue;
    }
    if (arg === '--runners' && argv[i + 1]) {
      args.runners = argv[++i]
        .split(',')
        .map(x => x.trim())
        .filter(Boolean);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(args.hours) || args.hours <= 0) {
    throw new Error(`Invalid --hours value: ${args.hours}`);
  }
  if (args.runners.length === 0) {
    throw new Error('At least one runner is required');
  }

  return args;
}

function hasTable(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return Boolean(row);
}

function count(db, sql, params = []) {
  return Number(db.prepare(sql).get(...params)?.c || 0);
}

function fmtRatio(numerator, denominator) {
  if (!denominator) return 'n/a';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function printHelp() {
  console.log(`Suboculo provenance self-check

Usage:
  node scripts/check-provenance.js [options]

Options:
  --db <path>                SQLite DB path (default: SUBOCULO_DB_PATH or backend/events.db)
  --hours <n>                Lookback window in hours (default: 72)
  --runners <a,b>            Comma-separated runners (default: claude-code,opencode)
  --strict-task-runs         Fail if no derived task_runs exist in window
  -h, --help                 Show this help
`);
}

function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const sinceIso = new Date(Date.now() - args.hours * 60 * 60 * 1000).toISOString();
  const db = new Database(args.dbPath, { readonly: true, fileMustExist: true });

  if (!hasTable(db, 'entries')) {
    throw new Error('Missing entries table in database');
  }

  const hasTaskRuns = hasTable(db, 'task_runs');
  const failures = [];
  const warnings = [];

  console.log(`Provenance self-check`);
  console.log(`DB: ${args.dbPath}`);
  console.log(`Window start: ${sinceIso}`);
  console.log(`Runners: ${args.runners.join(', ')}`);
  console.log('');

  for (const runner of args.runners) {
    const entriesTotal = count(
      db,
      `SELECT COUNT(*) AS c FROM entries WHERE runner=? AND ts >= ?`,
      [runner, sinceIso]
    );
    const toolEndTotal = count(
      db,
      `SELECT COUNT(*) AS c
       FROM entries
       WHERE runner=? AND event='tool.end' AND ts >= ?`,
      [runner, sinceIso]
    );
    const toolEndWithModel = count(
      db,
      `SELECT COUNT(*) AS c
       FROM entries
       WHERE runner=? AND event='tool.end' AND ts >= ?
         AND COALESCE(NULLIF(json_extract(data, '$.model'), ''), NULL) IS NOT NULL`,
      [runner, sinceIso]
    );

    const sessionStartTotal = count(
      db,
      `SELECT COUNT(*) AS c
       FROM entries
       WHERE runner=? AND event='session.start' AND ts >= ?`,
      [runner, sinceIso]
    );
    const sessionStartWithRunnerVersion = count(
      db,
      `SELECT COUNT(*) AS c
       FROM entries
       WHERE runner=? AND event='session.start' AND ts >= ?
         AND COALESCE(NULLIF(json_extract(data, '$.runnerVersion'), ''), NULL) IS NOT NULL`,
      [runner, sinceIso]
    );
    const toolEndWithRunnerVersion = count(
      db,
      `SELECT COUNT(*) AS c
       FROM entries
       WHERE runner=? AND event='tool.end' AND ts >= ?
         AND COALESCE(NULLIF(json_extract(data, '$.runnerVersion'), ''), NULL) IS NOT NULL`,
      [runner, sinceIso]
    );

    console.log(`[${runner}]`);
    console.log(`  entries: ${entriesTotal}`);
    console.log(`  tool.end model coverage: ${toolEndWithModel}/${toolEndTotal} (${fmtRatio(toolEndWithModel, toolEndTotal)})`);
    console.log(`  session.start runnerVersion coverage: ${sessionStartWithRunnerVersion}/${sessionStartTotal} (${fmtRatio(sessionStartWithRunnerVersion, sessionStartTotal)})`);
    console.log(`  tool.end runnerVersion coverage: ${toolEndWithRunnerVersion}/${toolEndTotal} (${fmtRatio(toolEndWithRunnerVersion, toolEndTotal)})`);

    if (entriesTotal === 0) {
      failures.push(`${runner}: no events in selected window`);
    }
    if (toolEndTotal > 0 && toolEndWithModel === 0) {
      failures.push(`${runner}: tool.end events exist but none include data.model`);
    }
    if (sessionStartTotal > 0 && sessionStartWithRunnerVersion === 0 && toolEndWithRunnerVersion === 0) {
      failures.push(`${runner}: no runnerVersion found on session.start or tool.end events`);
    }

    if (hasTaskRuns) {
      const taskRunsTotal = count(
        db,
        `SELECT COUNT(*) AS c
         FROM task_runs
         WHERE runner=? AND COALESCE(started_at, '') >= ?`,
        [runner, sinceIso]
      );
      const taskRunsWithModel = count(
        db,
        `SELECT COUNT(*) AS c
         FROM task_runs
         WHERE runner=? AND COALESCE(started_at, '') >= ?
           AND COALESCE(NULLIF(model, ''), NULL) IS NOT NULL`,
        [runner, sinceIso]
      );
      const taskRunsWithRunnerVersion = count(
        db,
        `SELECT COUNT(*) AS c
         FROM task_runs
         WHERE runner=? AND COALESCE(started_at, '') >= ?
           AND COALESCE(NULLIF(agent_system_version, ''), NULL) IS NOT NULL`,
        [runner, sinceIso]
      );

      console.log(`  task_runs model coverage: ${taskRunsWithModel}/${taskRunsTotal} (${fmtRatio(taskRunsWithModel, taskRunsTotal)})`);
      console.log(`  task_runs runnerVersion coverage: ${taskRunsWithRunnerVersion}/${taskRunsTotal} (${fmtRatio(taskRunsWithRunnerVersion, taskRunsTotal)})`);

      if (taskRunsTotal === 0) {
        const msg = `${runner}: no task_runs in selected window (run POST /api/task-runs/derive after ingesting events)`;
        if (args.strictTaskRuns) failures.push(msg);
        else warnings.push(msg);
      } else {
        if (taskRunsWithModel === 0) {
          failures.push(`${runner}: task_runs exist but none include model`);
        }
        if (taskRunsWithRunnerVersion === 0) {
          failures.push(`${runner}: task_runs exist but none include agent_system_version`);
        }
      }
    } else {
      warnings.push('task_runs table missing; run backend with phase-2 schema initialization before provenance checks');
    }

    console.log('');
  }

  if (warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of warnings) console.log(`- ${warning}`);
    console.log('');
  }

  if (failures.length > 0) {
    console.error('FAIL: provenance self-check failed');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log('PASS: provenance self-check passed');
}

try {
  run();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}

