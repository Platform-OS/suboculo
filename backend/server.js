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

    for (const event of events) {
      decodeBase64Fields(event);
      sseEmitter.emit('event', { __key: sseKey(event), ...event });
    }

    res.json({ success: true, count: events.length });
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
    const { tagsByKey, notesByKey } = req.body;

    // Clear existing
    db.exec('DELETE FROM tags');
    db.exec('DELETE FROM notes');

    // Insert tags
    const insertTag = db.prepare('INSERT OR IGNORE INTO tags (entry_key, tag) VALUES (?, ?)');
    const insertTags = db.transaction((entries) => {
      for (const [key, tags] of entries) {
        for (const tag of tags) {
          insertTag.run(key, tag);
        }
      }
    });

    if (tagsByKey) {
      insertTags(Object.entries(tagsByKey));
    }

    // Insert notes
    const insertNote = db.prepare('INSERT OR REPLACE INTO notes (entry_key, note) VALUES (?, ?)');
    const insertNotes = db.transaction((entries) => {
      for (const [key, note] of entries) {
        insertNote.run(key, note);
      }
    });

    if (notesByKey) {
      insertNotes(Object.entries(notesByKey));
    }

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
