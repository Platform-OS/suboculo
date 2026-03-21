#!/usr/bin/env node

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.SUBOCULO_DB_PATH || path.join(__dirname, '..', 'events.db');
const db = new Database(dbPath);

try {
  db.pragma('foreign_keys = ON');

  const before = db.prepare('SELECT COUNT(*) AS count FROM task_runs WHERE source = ?').get('derived_session').count;
  const info = db.prepare('DELETE FROM task_runs WHERE source = ?').run('derived_session');
  const after = db.prepare('SELECT COUNT(*) AS count FROM task_runs WHERE source = ?').get('derived_session').count;

  console.log(`[suboculo] DB: ${dbPath}`);
  console.log(`[suboculo] Removed legacy derived_session task runs: ${info.changes}`);
  console.log(`[suboculo] Before: ${before}, After: ${after}`);
} catch (error) {
  console.error('[suboculo] Cleanup failed:', error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
