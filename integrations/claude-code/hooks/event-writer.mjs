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
import { mkdirSync, existsSync, openSync, readSync, closeSync, statSync } from 'fs';
import { execFileSync } from 'child_process';

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
db.pragma('busy_timeout = 5000'); // Wait up to 5s for lock under concurrent writes

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
function normalizeTimestamp(ts) {
  if (!ts) return ts;
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return ts;
  return parsed.toISOString();
}

function validateCEPEvent(event) {
  const errors = [];

  if (!event.ts) errors.push('Missing required field: ts');
  if (!event.event) errors.push('Missing required field: event');
  if (!event.runner) errors.push('Missing required field: runner');

  const validEvents = [
    'session.start', 'session.end', 'session.update',
    'tool.start', 'tool.end',
    'message', 'error', 'subagent.spawn', 'subagent.stop', 'usage', 'custom'
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
  // Usage events: unique by session + model + agent + timestamp
  if (event.event === 'usage' && event.sessionId) {
    const agent = event.data?.agentId || 'lead';
    const model = event.data?.model || 'unknown';
    return `usage::${event.sessionId}::${model}::${agent}::${event.ts}`;
  }
  // Subagent lifecycle events have no traceId — use agentId to prevent
  // key collisions when multiple agents spawn/stop in the same second
  if (event.data?.agentId && event.sessionId && event.event) {
    return `${event.sessionId}::${event.event}::${event.data.agentId}::${event.ts}`;
  }
  if (event.sessionId && event.event && event.ts) {
    return `${event.sessionId}::${event.event}::${event.ts}`;
  }
  return `${event.ts}::0`;
}

// Insert event (from cep-processor.js)
function insertCEPEvent(event) {
  if (event && event.ts) {
    event.ts = normalizeTimestamp(event.ts);
  }
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

// --- Subagent transcript extraction ---

const NOTIFY_PORT = 3000;

// Scan forward from byteOffset to find the byte position after the next newline
function seekPastNewline(fd, byteOffset, fileSize, buf) {
  let pos = byteOffset;
  while (pos < fileSize) {
    const toRead = Math.min(buf.length, fileSize - pos);
    const bytesRead = readSync(fd, buf, 0, toRead, pos);
    if (bytesRead === 0) return fileSize;
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0x0A) return pos + i + 1;
    }
    pos += bytesRead;
  }
  return fileSize;
}

// Read one complete JSONL line starting at offset
function readLineAt(fd, offset, fileSize, buf) {
  if (offset >= fileSize) return { line: null, nextOffset: fileSize };
  let result = '';
  let pos = offset;
  while (pos < fileSize) {
    const toRead = Math.min(buf.length, fileSize - pos);
    const bytesRead = readSync(fd, buf, 0, toRead, pos);
    if (bytesRead === 0) break;
    const chunk = buf.toString('utf8', 0, bytesRead);
    const nlIdx = chunk.indexOf('\n');
    if (nlIdx !== -1) {
      result += chunk.substring(0, nlIdx);
      return { line: result, nextOffset: pos + nlIdx + 1 };
    }
    result += chunk;
    pos += bytesRead;
  }
  return { line: result || null, nextOffset: fileSize };
}

// Extract timestamp from a JSONL line via regex (no JSON parse)
const TS_RE = /"timestamp":"([^"]+)"/;
function extractTimestamp(line) {
  const m = TS_RE.exec(line);
  return m ? m[1] : null;
}

// Binary search JSONL file for byte offset of first line with timestamp >= targetTs
function findOffsetByTimestamp(filePath, targetTs) {
  const { size: fileSize } = statSync(filePath);
  if (fileSize === 0) return 0;

  let fd;
  const buf = Buffer.alloc(8192);
  // 2s buffer for clock precision
  const target = new Date(new Date(targetTs).getTime() - 2000).toISOString();

  try {
    fd = openSync(filePath, 'r');

    let lo = 0, hi = fileSize;
    let bestOffset = fileSize;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const lineStart = mid === 0 ? 0 : seekPastNewline(fd, mid, fileSize, buf);

      if (lineStart >= fileSize) {
        hi = mid;
        continue;
      }

      const { line, nextOffset } = readLineAt(fd, lineStart, fileSize, buf);
      if (!line) {
        hi = mid;
        continue;
      }

      const ts = extractTimestamp(line);
      if (!ts || ts < target) {
        lo = nextOffset;
      } else {
        hi = mid;
        bestOffset = lineStart;
      }
    }

    return bestOffset;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Parse transcript from offset, extract subagent tool calls as CEP events
function extractSubagentToolCalls(transcriptPath, taskTraceId, sessionId, startTs, endTs, fallbackAgentType = null) {
  const offset = findOffsetByTimestamp(transcriptPath, startTs);
  const { size: fileSize } = statSync(transcriptPath);

  if (offset >= fileSize) return [];

  let fd;
  const buf = Buffer.alloc(64 * 1024); // 64KB read buffer

  try {
    fd = openSync(transcriptPath, 'r');

    const events = [];
    const toolNames = new Map(); // tool_use_id → tool name
    let pos = offset;

    // Upper bound: stop scanning past endTs + 2s buffer
    const upperTs = new Date(new Date(endTs).getTime() + 2000).toISOString();

    while (pos < fileSize) {
      const { line, nextOffset } = readLineAt(fd, pos, fileSize, buf);
      if (!line) break;
      pos = nextOffset;

      // Quick reject: must reference parent Task's traceId
      if (!line.includes(taskTraceId)) {
        const ts = extractTimestamp(line);
        if (ts && ts > upperTs) break;
        continue;
      }
      if (!line.includes('"progress"')) continue;

      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry.type !== 'progress') continue;
      if (entry.parentToolUseID !== taskTraceId) continue;

      const msg = entry.data?.message;
      if (!msg?.message?.content) continue;

      const agentId = entry.data?.agentId;
      const agentType = entry.data?.agentType || fallbackAgentType || null;
      const ts = msg.timestamp || entry.timestamp;
      const content = msg.message.content;

      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type === 'tool_use') {
          toolNames.set(block.id, block.name);
          events.push({
            ts,
            event: 'tool.start',
            runner: 'claude-code',
            sessionId,
            traceId: block.id,
            data: {
              tool: block.name,
              agentId,
              agentType,
              parentTraceId: taskTraceId,
              args: block.input
            }
          });
        } else if (block.type === 'tool_result') {
          const toolName = toolNames.get(block.tool_use_id) || 'unknown';
          events.push({
            ts,
            event: 'tool.end',
            runner: 'claude-code',
            sessionId,
            traceId: block.tool_use_id,
            data: {
              tool: toolName,
              agentId,
              agentType,
              parentTraceId: taskTraceId,
              status: block.is_error ? 'error' : 'success',
              response: typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content)
            }
          });
        }
      }
    }

    return events;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Extract all token usage entries from transcript as CEP events
function extractUsageFromTranscript(transcriptPath, sessionId) {
  const { size: fileSize } = statSync(transcriptPath);
  if (fileSize === 0) return [];

  let fd;
  const buf = Buffer.alloc(64 * 1024);

  try {
    fd = openSync(transcriptPath, 'r');

    const events = [];
    const agentTypesById = new Map();
    let pos = 0;

    while (pos < fileSize) {
      const { line, nextOffset } = readLineAt(fd, pos, fileSize, buf);
      if (!line) break;
      pos = nextOffset;

      if (line.includes('"agentId"') && line.includes('"agentType"')) {
        let maybeAgentEntry;
        try { maybeAgentEntry = JSON.parse(line); } catch { maybeAgentEntry = null; }

        const mappedAgentId = maybeAgentEntry?.data?.agentId || maybeAgentEntry?.agentId || null;
        const mappedAgentType = maybeAgentEntry?.data?.agentType || maybeAgentEntry?.agentType || null;
        if (mappedAgentId && mappedAgentType && !agentTypesById.has(mappedAgentId)) {
          agentTypesById.set(mappedAgentId, mappedAgentType);
        }
      }

      // Quick reject: must contain usage data
      if (!line.includes('"usage"')) continue;
      // Skip non-message progress entries
      if (line.includes('"hook_progress"') || line.includes('"mcp_progress"')) continue;

      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      let usage, model, agentId, agentType, ts;

      if (entry.type === 'assistant' && entry.message?.usage) {
        // Main agent API response
        usage = entry.message.usage;
        model = entry.message?.model || entry.model || 'unknown';
        ts = entry.timestamp;
        agentId = null;
        agentType = 'lead';
      } else if (entry.type === 'progress') {
        if (entry.data?.type !== 'agent_progress') continue;
        const innerMsg = entry.data?.message;
        if (!innerMsg?.message?.usage) continue;

        usage = innerMsg.message.usage;
        model = innerMsg.message?.model || innerMsg.model || entry.model || 'unknown';
        agentId = entry.data?.agentId || entry.agentId || null;
        agentType = entry.data?.agentType || innerMsg.agentType || null;
        ts = innerMsg.timestamp || entry.timestamp;
      } else {
        continue;
      }

      if (!usage || !ts) continue;

      // Skip synthetic/zero entries
      if (model === '<synthetic>') continue;
      const inp = usage.input_tokens || 0;
      const out = usage.output_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      if (inp === 0 && out === 0 && cacheCreate === 0 && cacheRead === 0) continue;

      const evt = {
        ts,
        event: 'usage',
        runner: 'claude-code',
        sessionId,
        data: {
          model,
          inputTokens: inp,
          outputTokens: out,
          cacheCreationTokens: cacheCreate,
          cacheReadTokens: cacheRead,
        }
      };
      if (agentId) evt.data.agentId = agentId;
      if (agentType) evt.data.agentType = agentType;

      events.push(evt);
    }

    for (const evt of events) {
      if (evt.data?.agentId && !evt.data?.agentType) {
        evt.data.agentType = agentTypesById.get(evt.data.agentId)
          || db.prepare(
            `SELECT subagentType
             FROM entries
             WHERE sessionID = ? AND agentId = ? AND subagentType IS NOT NULL
             ORDER BY ts DESC
             LIMIT 1`
          ).get(sessionId, evt.data.agentId)?.subagentType
          || null;
      }
    }

    return events;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Fire-and-forget batch SSE notification
function notifyBatch(events) {
  try {
    execFileSync('curl', [
      '-s', '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify(events),
      `http://localhost:${NOTIFY_PORT}/api/notify/batch`,
      '--max-time', '2'
    ], { timeout: 3000, stdio: 'ignore' });
  } catch {
    // Fire-and-forget — server may not be running
  }
}

// Orchestrator: extract subagent tool calls from transcript and insert into DB
function extractAndInsertSubagentEvents(event) {
  const { traceId, sessionId, ts: endTs } = event;
  const { transcriptPath } = event.data;

  if (!transcriptPath || !existsSync(transcriptPath)) return;

  // Get start timestamp from matching tool.start
  let startTs;
  try {
    const row = db.prepare(
      `SELECT ts FROM entries WHERE traceId = ? AND event = 'tool.start' LIMIT 1`
    ).get(traceId);
    startTs = row?.ts;
  } catch { /* ignore */ }

  if (!startTs) {
    // Fallback: 1 hour before end
    startTs = new Date(new Date(endTs).getTime() - 3600000).toISOString();
  }

  const extracted = extractSubagentToolCalls(
    transcriptPath,
    traceId,
    sessionId,
    startTs,
    endTs,
    event.data?.agentType || event.data?.args?.subagent_type || null
  );
  if (extracted.length === 0) return;

  // Dedup: find events already captured by hooks (same traceId + event type)
  // so we can ENRICH them with agentId/parentTraceId instead of inserting duplicates
  const traceIds = [...new Set(extracted.map(e => e.traceId).filter(Boolean))];
  const existingMap = new Map();

  for (let i = 0; i < traceIds.length; i += 100) {
    const batch = traceIds.slice(i, i + 100);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT key, traceId, event, data FROM entries
       WHERE traceId IN (${placeholders}) AND event IN ('tool.start', 'tool.end')`
    ).all(...batch);
    for (const row of rows) {
      existingMap.set(`${row.traceId}::${row.event}`, row);
    }
  }

  const updateStmt = db.prepare(
    `UPDATE entries SET agentId = ?, subagentType = ?, data = ? WHERE key = ?`
  );
  const newEvents = [];
  let enrichedCount = 0;

  const processAll = db.transaction(() => {
    for (const evt of extracted) {
      const existing = existingMap.get(`${evt.traceId}::${evt.event}`);

      if (existing) {
        // Enrich hook-captured event with attribution (no duplicate)
        const existingData = JSON.parse(existing.data);
        if (!existingData.data) existingData.data = {};
        existingData.data.agentId = evt.data.agentId;
        if (evt.data.agentType) {
          existingData.data.agentType = evt.data.agentType;
        }
        existingData.data.parentTraceId = evt.data.parentTraceId;
        updateStmt.run(
          evt.data.agentId,
          evt.data.agentType || null,
          JSON.stringify(existingData),
          existing.key
        );
        enrichedCount++;
      } else {
        // New event not captured by hooks — insert
        try { insertCEPEvent(evt); newEvents.push(evt); } catch { /* skip */ }
      }
    }
  });
  processAll();

  // SSE notification only for truly new events (enriched ones were already sent by hooks)
  if (newEvents.length > 0) notifyBatch(newEvents);

  console.error(`[suboculo] Task ${traceId}: ${enrichedCount} enriched, ${newEvents.length} new (${extracted.length} total from transcript)`);

  // Extract all token usage from transcript (main agent + subagents)
  try {
    const usageEvents = extractUsageFromTranscript(transcriptPath, sessionId);
    if (usageEvents.length > 0) {
      const insertUsage = db.transaction(() => {
        for (const evt of usageEvents) {
          try { insertCEPEvent(evt); } catch { /* duplicate key — skip */ }
        }
      });
      insertUsage();
      console.error(`[suboculo] Usage: ${usageEvents.length} events extracted from transcript`);
    }
  } catch (err) {
    console.error('[suboculo] Usage extraction failed (non-fatal):', err.message);
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

    // After successful insert, extract subagent inner tool calls for Task tool.end
    if (event.event === 'tool.end' && event.data?.tool === 'Task' && event.data?.transcriptPath) {
      try {
        extractAndInsertSubagentEvents(event);
      } catch (err) {
        console.error('[suboculo] Subagent extraction failed (non-fatal):', err.message);
      }
    } else if (event.event === 'tool.end' && event.data?.transcriptPath) {
      // For non-Task tool.end events, extract usage if not yet done for this session
      try {
        const hasUsage = db.prepare(
          'SELECT 1 FROM entries WHERE sessionID = ? AND event = ? LIMIT 1'
        ).get(event.sessionId, 'usage');
        if (!hasUsage) {
          const usageEvents = extractUsageFromTranscript(event.data.transcriptPath, event.sessionId);
          if (usageEvents.length > 0) {
            const insertUsage = db.transaction(() => {
              for (const evt of usageEvents) {
                try { insertCEPEvent(evt); } catch { /* skip */ }
              }
            });
            insertUsage();
            console.error(`[suboculo] Usage (first extract): ${usageEvents.length} events`);
          }
        }
      } catch (err) {
        console.error('[suboculo] Usage extraction failed (non-fatal):', err.message);
      }
    }
  } catch (err) {
    console.error('Failed to insert event:', err.message);
    process.exit(1);
  } finally {
    db.close();
  }
}
