#!/usr/bin/env node

/**
 * Suboculo Event Writer
 *
 * Standalone script that reads CEP events from argv and writes them
 * to a local SQLite database at {CWD}/.suboculo/events.db
 *
 * Usage: echo '{"ts":"...","event":"..."}' | node writer.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// Database path: .suboculo/events.db in current working directory
const CWD = process.cwd();
const DB_DIR = join(CWD, '.suboculo');
const DB_PATH = join(DB_DIR, 'events.db');

// Ensure .suboculo directory exists
if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

// Open/create database
const db = new Database(DB_PATH);

// Initialize schema (idempotent)
function initSchema() {
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
      data TEXT NOT NULL,
      runner TEXT,
      event TEXT,
      traceId TEXT,
      status TEXT,
      agentId TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runner ON entries(runner);
    CREATE INDEX IF NOT EXISTS idx_event ON entries(event);
    CREATE INDEX IF NOT EXISTS idx_traceId ON entries(traceId);
    CREATE INDEX IF NOT EXISTS idx_status ON entries(status);
    CREATE INDEX IF NOT EXISTS idx_agentId ON entries(agentId);
    CREATE INDEX IF NOT EXISTS idx_kind ON entries(kind);
    CREATE INDEX IF NOT EXISTS idx_tool ON entries(tool);
    CREATE INDEX IF NOT EXISTS idx_ts ON entries(ts);
    CREATE INDEX IF NOT EXISTS idx_sessionID ON entries(sessionID);
    CREATE INDEX IF NOT EXISTS idx_rootSessionID ON entries(rootSessionID);
  `);

  // Migrate: add columns that may not exist in older databases
  const migrations = ['runner', 'event', 'traceId', 'status', 'agentId'];
  for (const col of migrations) {
    try {
      db.exec(`ALTER TABLE entries ADD COLUMN ${col} TEXT`);
    } catch {
      // Column already exists
    }
  }
}

initSchema();

// Validation (from cep-processor.js)
function validateCEPEvent(event) {
  const errors = [];

  if (!event.ts) errors.push('Missing required field: ts');
  if (!event.event) errors.push('Missing required field: event');
  if (!event.runner) errors.push('Missing required field: runner');

  const validEvents = [
    'session.start', 'session.end', 'session.update',
    'tool.start', 'tool.end',
    'message', 'error', 'subagent.spawn', 'subagent.stop', 'custom'
  ];
  if (event.event && !validEvents.includes(event.event)) {
    errors.push(`Invalid event type: ${event.event}`);
  }

  if (event.ts && !/^\d{4}-\d{2}-\d{2}T/.test(event.ts)) {
    errors.push('Invalid timestamp format (expected ISO 8601)');
  }

  return { valid: errors.length === 0, errors };
}

// Generate unique key (from cep-processor.js)
function generateCEPKey(event) {
  if (event.traceId && event.event) {
    return `${event.traceId}::${event.event}::${event.ts}`;
  }
  if (event.sessionId && event.event && event.ts) {
    return `${event.sessionId}::${event.event}::${event.ts}`;
  }
  return `${event.ts}::0`;
}

// Insert event (from cep-processor.js)
function insertCEPEvent(event) {
  const key = generateCEPKey(event);

  const ts = event.ts || null;
  const cepEvent = event.event || null;
  const runner = event.runner || null;
  const sessionId = event.sessionId || null;
  const parentSessionId = event.parentSessionId || null;
  const traceId = event.traceId || null;

  const data = event.data || {};
  const tool = data.tool || null;
  let durationMs = data.durationMs || null;
  const outputLen = data.outputLen || null;
  const outputPreview = data.outputPreview || null;
  const title = data.title || null;
  const subagentType = data.agentType || data.subagentType || null;
  const agentId = data.agentId || null;
  const childSessionId = data.childSessionId || null;
  const args = data.args ? JSON.stringify(data.args) : null;
  const status = data.status || null;

  // Calculate duration for tool.end events
  if (event.event === 'tool.end' && event.traceId && !durationMs) {
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
        durationMs = endTime - startTime;
      }
    } catch (err) {
      // Duration calculation failed, continue without it
    }
  }

  const rootSessionId = parentSessionId || sessionId;

  // Inject calculated values back into event data before serializing,
  // so the stored JSON blob has complete data for the API to return
  if (durationMs != null) {
    if (!event.data) event.data = {};
    event.data.durationMs = durationMs;
  }
  if (status && (!event.data || !event.data.status)) {
    if (!event.data) event.data = {};
    event.data.status = status;
  }

  const eventData = JSON.stringify(event);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO entries
    (key, ts, kind, type, tool, sessionID, rootSessionID, subagentType,
     callID, durationMs, outputLen, outputPreview, title,
     parentSessionID, childSessionID, args, data,
     runner, event, traceId, status, agentId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    key, ts, cepEvent, null, tool, sessionId, rootSessionId, subagentType,
    traceId, durationMs, outputLen, outputPreview, title,
    parentSessionId, childSessionId, args, eventData,
    runner, cepEvent, traceId, status, agentId
  );

  return key;
}

// Read event from stdin (piped from jq)
let eventJSON = '';

// Read all data from stdin
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  eventJSON += chunk;
});

process.stdin.on('end', () => {
  if (!eventJSON.trim()) {
    console.error('Usage: echo \'{"ts":"...","event":"..."}\' | node writer.mjs');
    process.exit(1);
  }

  let event;
  try {
    event = JSON.parse(eventJSON);
  } catch (err) {
    console.error('Invalid JSON:', err.message);
    process.exit(1);
  }

  processEvent(event);
});

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

function processEvent(event) {
  // Decode base64 fields before storing
  decodeBase64Fields(event);

  // Validate and insert
  const validation = validateCEPEvent(event);
  if (!validation.valid) {
    console.error('Invalid CEP event:', validation.errors.join(', '));
    process.exit(1);
  }

  try {
    const key = insertCEPEvent(event);
    // Silent success (hooks don't need output)
  } catch (err) {
    console.error('Failed to insert event:', err.message);
    process.exit(1);
  } finally {
    db.close();
  }
}
