#!/usr/bin/env node

// Suboculo MCP Server
// Exposes read-only tools for querying the Suboculo SQLite database.
// Runs as a stdio MCP server — console.log is forbidden (corrupts JSON-RPC).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'module';
import { resolve } from 'path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let dbPath = process.env.SUBOCULO_DB_PATH;
if (!dbPath) {
  console.error('[suboculo-mcp] SUBOCULO_DB_PATH environment variable is required');
  process.exit(1);
}

// If relative path, resolve against CWD (the project being monitored)
if (!dbPath.startsWith('/')) {
  dbPath = resolve(process.cwd(), dbPath);
}

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (err) {
  console.error(`[suboculo-mcp] Failed to open database at ${dbPath}: ${err.message}`);
  process.exit(1);
}

// Decode base64-encoded fields from hooks (safe shell transport → readable data)
function decodeBase64Fields(data) {
  if (!data) return data;
  for (const field of ['args', 'response']) {
    if (typeof data[field] !== 'string') continue;
    try {
      data[field] = JSON.parse(Buffer.from(data[field], 'base64').toString('utf-8'));
    } catch {
      // Not base64 or not JSON — leave as-is
    }
  }
  return data;
}

// Shared event renderer — returns formatted lines for a single CEP event
function formatEventLines(cepEvent, limit = 200) {
  const lines = [];
  const d = cepEvent.data || {};

  if (d.tool) lines.push(`   Tool: ${d.tool}`);
  if (cepEvent.runner) lines.push(`   Runner: ${cepEvent.runner}`);
  if (d.agentType || d.agentId) {
    const label = d.agentType
      ? `${d.agentType}${d.agentId ? ` (${d.agentId})` : ''}`
      : d.agentId;
    lines.push(`   Agent: ${label}`);
  }
  if (cepEvent.sessionId) lines.push(`   Session: ${cepEvent.sessionId}`);
  if (cepEvent.traceId) lines.push(`   Trace: ${cepEvent.traceId}`);
  if (d.parentTraceId) lines.push(`   Parent Task: ${d.parentTraceId}`);
  if (d.durationMs) lines.push(`   Duration: ${d.durationMs}ms`);
  if (d.status) lines.push(`   Status: ${d.status}`);

  if (d.args) {
    const s = JSON.stringify(d.args);
    lines.push(`   Args: ${s.length <= limit ? s : s.substring(0, limit) + '...'}`);
  }

  // Response (tool output from tool.end / subagent.stop)
  const resp = d.response;
  if (resp) {
    const s = typeof resp === 'string' ? resp : JSON.stringify(resp);
    lines.push(`   Response: ${s.length <= limit ? s : s.substring(0, limit) + '...'}`);
  }

  // Legacy result/outputPreview (only if no response)
  if (!resp) {
    const result = d.result || d.outputPreview;
    if (result) {
      const s = typeof result === 'string' ? result : JSON.stringify(result);
      lines.push(`   Result: ${s.length <= limit ? s : s.substring(0, limit) + '...'}`);
    }
  }

  return lines;
}

const server = new McpServer({
  name: 'suboculo',
  version: '0.1.0',
});

const suboculoPort = process.env.SUBOCULO_PORT || '3000';

function buildQueryParams(input, allowedKeys) {
  const params = new URLSearchParams();
  for (const key of allowedKeys) {
    const value = input?.[key];
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  return params;
}

async function callBackendJson(path, { method = 'GET', query = null, body = null } = {}) {
  const queryString = query ? `?${query.toString()}` : '';
  const url = `http://127.0.0.1:${suboculoPort}${path}${queryString}`;
  const options = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };

  const response = await fetch(url, options);
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { error: await response.text() };
  }

  if (!response.ok) {
    const msg = payload?.error || response.statusText || 'Request failed';
    throw new Error(`${method} ${path} failed (${response.status}): ${msg}`);
  }
  return payload;
}

function toMcpText(obj, heading) {
  const text = heading
    ? `${heading}\n\n${JSON.stringify(obj, null, 2)}`
    : JSON.stringify(obj, null, 2);
  return { content: [{ type: 'text', text }] };
}

// ── Tool 1: suboculo_get_facets ─────────────────────────────────────────────

server.tool(
  'suboculo_get_facets',
  'List available runners, event types, tools, and sessions in the Suboculo database. Use this first to discover what data exists.',
  {},
  async () => {
    const runners = db.prepare('SELECT DISTINCT runner FROM entries WHERE runner IS NOT NULL ORDER BY runner').all();
    const events = db.prepare('SELECT DISTINCT event FROM entries WHERE event IS NOT NULL ORDER BY event').all();
    const tools = db.prepare('SELECT DISTINCT tool FROM entries WHERE tool IS NOT NULL ORDER BY tool').all();
    const agentTypes = db.prepare('SELECT DISTINCT subagentType FROM entries WHERE subagentType IS NOT NULL ORDER BY subagentType').all();
    const agentIds = db.prepare(`
      SELECT DISTINCT agentId, subagentType
      FROM entries
      WHERE agentId IS NOT NULL
      ORDER BY agentId
    `).all();
    const sessions = db.prepare(`
      SELECT DISTINCT sessionID, runner, MIN(ts) as firstSeen
      FROM entries
      WHERE sessionID IS NOT NULL
      GROUP BY sessionID
      ORDER BY firstSeen DESC
      LIMIT 50
    `).all();

    const lines = [];
    lines.push('=== Suboculo Data Facets ===\n');

    lines.push(`Runners (${runners.length}):`);
    runners.forEach(r => lines.push(`  - ${r.runner}`));

    lines.push(`\nEvent types (${events.length}):`);
    events.forEach(r => lines.push(`  - ${r.event}`));

    lines.push(`\nTools (${tools.length}):`);
    tools.forEach(r => lines.push(`  - ${r.tool}`));

    lines.push(`\nAgent types (${agentTypes.length}):`);
    if (agentTypes.length === 0) {
      lines.push('  (none — all events from lead agent)');
    } else {
      agentTypes.forEach(r => lines.push(`  - ${r.subagentType}`));
    }

    lines.push(`\nAgent IDs (${agentIds.length}):`);
    if (agentIds.length === 0) {
      lines.push('  (none — no agent attribution data)');
    } else {
      agentIds.forEach(r => lines.push(`  - ${r.agentId}${r.subagentType ? ` (${r.subagentType})` : ''}`));
    }

    lines.push(`\nRecent sessions (up to 50):`);
    sessions.forEach(s => {
      lines.push(`  - ${s.sessionID} [${s.runner || 'unknown'}] first seen: ${s.firstSeen}`);
    });

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Tool 2: suboculo_get_stats ──────────────────────────────────────────────

server.tool(
  'suboculo_get_stats',
  'Get summary statistics: total events, top tools by usage, average tool duration, and recent sessions.',
  {},
  async () => {
    const total = db.prepare('SELECT COUNT(*) as count FROM entries').get();

    const topTools = db.prepare(`
      SELECT tool, COUNT(*) as count
      FROM entries
      WHERE tool IS NOT NULL
      GROUP BY tool
      ORDER BY count DESC
      LIMIT 15
    `).all();

    const avgDuration = db.prepare(`
      SELECT AVG(durationMs) as avg, MIN(durationMs) as min, MAX(durationMs) as max
      FROM entries
      WHERE durationMs IS NOT NULL AND durationMs > 0
    `).get();

    const durationByTool = db.prepare(`
      SELECT tool, AVG(durationMs) as avg, COUNT(*) as count
      FROM entries
      WHERE durationMs IS NOT NULL AND durationMs > 0 AND tool IS NOT NULL
      GROUP BY tool
      ORDER BY avg DESC
      LIMIT 10
    `).all();

    const recentSessions = db.prepare(`
      SELECT sessionID, runner, MIN(ts) as started, MAX(ts) as lastEvent, COUNT(*) as eventCount
      FROM entries
      WHERE sessionID IS NOT NULL
      GROUP BY sessionID
      ORDER BY started DESC
      LIMIT 10
    `).all();

    const byEvent = db.prepare(`
      SELECT event, COUNT(*) as count
      FROM entries
      WHERE event IS NOT NULL
      GROUP BY event
      ORDER BY count DESC
    `).all();

    const lines = [];
    lines.push('=== Suboculo Statistics ===\n');
    lines.push(`Total events: ${total.count}`);

    lines.push('\nEvents by type:');
    byEvent.forEach(r => lines.push(`  ${r.event}: ${r.count}`));

    lines.push('\nTop tools by usage:');
    topTools.forEach(r => lines.push(`  ${r.tool}: ${r.count} events`));

    if (avgDuration.avg) {
      lines.push(`\nTool duration (ms):`);
      lines.push(`  Average: ${Math.round(avgDuration.avg)}ms`);
      lines.push(`  Min: ${avgDuration.min}ms`);
      lines.push(`  Max: ${avgDuration.max}ms`);

      lines.push('\nAverage duration by tool:');
      durationByTool.forEach(r => {
        lines.push(`  ${r.tool}: ${Math.round(r.avg)}ms (${r.count} samples)`);
      });
    }

    const agentStats = db.prepare(`
      SELECT agentId, subagentType, COUNT(*) as count
      FROM entries
      WHERE agentId IS NOT NULL
      GROUP BY agentId
      ORDER BY count DESC
      LIMIT 20
    `).all();
    const withAttribution = db.prepare(
      `SELECT COUNT(*) as count FROM entries WHERE agentId IS NOT NULL`
    ).get();
    const withParent = db.prepare(
      `SELECT COUNT(*) as count FROM entries WHERE data LIKE '%parentTraceId%'`
    ).get();

    lines.push('\nRecent sessions:');
    recentSessions.forEach(s => {
      lines.push(`  ${s.sessionID}`);
      lines.push(`    Runner: ${s.runner || 'unknown'}`);
      lines.push(`    Started: ${s.started}`);
      lines.push(`    Last event: ${s.lastEvent}`);
      lines.push(`    Events: ${s.eventCount}`);
    });

    lines.push(`\nAgent attribution:`);
    lines.push(`  Events with agentId: ${withAttribution.count} of ${total.count}`);
    lines.push(`  Events with parentTraceId: ${withParent.count}`);
    if (agentStats.length > 0) {
      lines.push('  Events by agent:');
      agentStats.forEach(r => {
        lines.push(`    ${r.agentId}${r.subagentType ? ` (${r.subagentType})` : ''}: ${r.count}`);
      });
    }

    // Token usage summary
    const usageCount = db.prepare(`SELECT COUNT(*) as count FROM entries WHERE event = 'usage'`).get();
    if (usageCount.count > 0) {
      lines.push(`\nToken usage: ${usageCount.count} usage events recorded`);
      lines.push('  Use suboculo_get_usage for detailed breakdown.');
    } else {
      lines.push('\nToken usage: no data yet (extracted from transcripts on Task completion)');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Tool 3: suboculo_list_sessions ──────────────────────────────────────────

server.tool(
  'suboculo_list_sessions',
  'List recent sessions with start/end time, event count, and tools used.',
  {
    limit: z.number().min(1).max(50).default(20).describe('Max sessions to return (default 20)'),
    runner: z.string().optional().describe('Filter by runner (e.g. "claude-code")'),
  },
  async ({ limit, runner }) => {
    let sql = `
      SELECT
        sessionID,
        runner,
        MIN(ts) as started,
        MAX(ts) as lastEvent,
        COUNT(*) as eventCount,
        COUNT(DISTINCT tool) as toolCount,
        GROUP_CONCAT(DISTINCT tool) as tools
      FROM entries
      WHERE sessionID IS NOT NULL
    `;
    const params = [];

    if (runner) {
      sql += ' AND runner = ?';
      params.push(runner);
    }

    sql += ` GROUP BY sessionID ORDER BY started DESC LIMIT ?`;
    params.push(limit);

    const sessions = db.prepare(sql).all(...params);

    if (sessions.length === 0) {
      return { content: [{ type: 'text', text: 'No sessions found.' }] };
    }

    const lines = [];
    lines.push(`=== Sessions (${sessions.length}) ===\n`);

    sessions.forEach((s, i) => {
      lines.push(`${i + 1}. Session: ${s.sessionID}`);
      lines.push(`   Runner: ${s.runner || 'unknown'}`);
      lines.push(`   Started: ${s.started}`);
      lines.push(`   Last event: ${s.lastEvent}`);
      lines.push(`   Events: ${s.eventCount} | Distinct tools: ${s.toolCount}`);
      if (s.tools) {
        lines.push(`   Tools: ${s.tools}`);
      }
      lines.push('');
    });

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Tool 4: suboculo_query_events ───────────────────────────────────────────

server.tool(
  'suboculo_query_events',
  'Query events with filters. Returns paginated results (max 200 per page). Use suboculo_get_facets first to discover valid filter values.',
  {
    runner: z.string().optional().describe('Filter by runner'),
    tool: z.string().optional().describe('Filter by tool name'),
    event: z.string().optional().describe('Filter by event type (e.g. "tool.start", "tool.end", "session.start")'),
    sessionId: z.string().optional().describe('Filter by session ID'),
    agentId: z.string().optional().describe('Filter by agent ID to see a specific subagent\'s activity'),
    parentTraceId: z.string().optional().describe('Filter by parent Task trace ID to see all inner tool calls of a Task'),
    search: z.string().optional().describe('Text search across args, output preview, and title'),
    since: z.string().optional().describe('Only events after this ISO timestamp (e.g. "2026-03-11T14:00:00Z")'),
    until: z.string().optional().describe('Only events before this ISO timestamp (e.g. "2026-03-11T15:00:00Z")'),
    limit: z.number().min(1).max(200).default(50).describe('Max events to return (default 50)'),
    offset: z.number().min(0).default(0).describe('Offset for pagination (default 0)'),
    sort: z.enum(['asc', 'desc']).default('desc').describe('Sort by timestamp (default desc = newest first)'),
  },
  async ({ runner, tool, event, sessionId, agentId, parentTraceId, search, since, until, limit, offset, sort }) => {
    let sql = 'SELECT key, ts, event, runner, tool, sessionID, traceId, durationMs, agentId, data FROM entries WHERE 1=1';
    const params = [];

    if (runner) {
      sql += ' AND runner = ?';
      params.push(runner);
    }
    if (tool) {
      sql += ' AND tool = ?';
      params.push(tool);
    }
    if (event) {
      sql += ' AND event = ?';
      params.push(event);
    }
    if (sessionId) {
      sql += ' AND sessionID = ?';
      params.push(sessionId);
    }
    if (agentId) {
      sql += ' AND agentId = ?';
      params.push(agentId);
    }
    if (parentTraceId) {
      sql += ' AND data LIKE ?';
      params.push(`%"parentTraceId":"${parentTraceId}"%`);
    }
    if (since) {
      sql += ' AND ts >= ?';
      params.push(since);
    }
    if (until) {
      sql += ' AND ts <= ?';
      params.push(until);
    }
    if (search) {
      sql += ' AND (args LIKE ? OR outputPreview LIKE ? OR title LIKE ? OR data LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    // Count total matches
    const countSql = sql.replace(
      'SELECT key, ts, event, runner, tool, sessionID, traceId, durationMs, agentId, data',
      'SELECT COUNT(*) as count'
    );
    const total = db.prepare(countSql).get(...params).count;

    // Apply sort and pagination
    const sortDir = sort === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ts ${sortDir} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params);

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `No events found (total matching: ${total}).` }] };
    }

    const lines = [];
    lines.push(`=== Events (showing ${rows.length} of ${total}, offset ${offset}) ===\n`);

    rows.forEach((row, i) => {
      const cep = JSON.parse(row.data);
      decodeBase64Fields(cep.data);
      lines.push(`${offset + i + 1}. [${row.ts}] ${row.event || cep.event}`);
      lines.push(...formatEventLines(cep, 200));
      lines.push('');
    });

    if (total > offset + rows.length) {
      lines.push(`\n--- ${total - offset - rows.length} more events. Use offset=${offset + rows.length} to see next page. ---`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Tool 5: suboculo_get_session ────────────────────────────────────────────

server.tool(
  'suboculo_get_session',
  'Get the full chronological timeline for a specific session. Shows all events in order.',
  {
    sessionId: z.string().describe('The session ID to retrieve'),
  },
  async ({ sessionId }) => {
    const rows = db.prepare(`
      SELECT key, ts, event, tool, runner, traceId, durationMs, data
      FROM entries
      WHERE sessionID = ?
      ORDER BY ts ASC
    `).all(sessionId);

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `No events found for session ${sessionId}.` }] };
    }

    const firstTs = rows[0].ts;
    const lastTs = rows[rows.length - 1].ts;
    const runner = rows[0].runner || 'unknown';
    const tools = [...new Set(rows.map(r => r.tool).filter(Boolean))];

    const lines = [];
    lines.push(`=== Session Timeline ===`);
    lines.push(`Session: ${sessionId}`);
    lines.push(`Runner: ${runner}`);
    lines.push(`Started: ${firstTs}`);
    lines.push(`Last event: ${lastTs}`);
    lines.push(`Total events: ${rows.length}`);
    lines.push(`Tools used: ${tools.join(', ') || 'none'}`);
    lines.push('');

    rows.forEach((row, i) => {
      const cep = JSON.parse(row.data);
      decodeBase64Fields(cep.data);
      lines.push(`${i + 1}. [${row.ts}] ${row.event || cep.event}`);
      lines.push(...formatEventLines(cep, 300));
      lines.push('');
    });

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Tool 6: suboculo_get_selection ───────────────────────────────────────────

server.tool(
  'suboculo_get_selection',
  'Get events selected in the Suboculo web UI. Use this when the user asks you to analyze their selected events. The web UI "Send to CLI" button saves the selection for this tool to read.',
  {},
  async () => {
    const selectionPath = dbPath.replace(/[^/]+$/, 'selection.json');

    let selectionData;
    try {
      const { readFileSync } = await import('fs');
      const raw = readFileSync(selectionPath, 'utf-8');
      selectionData = JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return {
          content: [{
            type: 'text',
            text: 'No events selected. Use the Suboculo web UI to select events and click "Send to CLI".'
          }]
        };
      }
      throw err;
    }

    if (!selectionData.events || selectionData.events.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'Selection file exists but contains no events. Select events in the web UI and click "Send to CLI".'
        }]
      };
    }

    const events = selectionData.events;
    const tools = [...new Set(events.map(e => e.data?.tool).filter(Boolean))];
    const runners = [...new Set(events.map(e => e.runner).filter(Boolean))];
    const sessions = [...new Set(events.map(e => e.sessionId).filter(Boolean))];

    const lines = [];
    lines.push('=== Selected Events from Web UI ===');
    lines.push(`Selected at: ${selectionData.timestamp}`);
    lines.push(`Total events: ${selectionData.count}`);
    lines.push(`Runners: ${runners.join(', ') || 'unknown'}`);
    lines.push(`Sessions: ${sessions.length}`);
    lines.push(`Tools used: ${tools.join(', ') || 'none'}`);
    lines.push('');

    events.forEach((e, i) => {
      decodeBase64Fields(e.data);
      lines.push(`${i + 1}. [${e.ts}] ${e.event}`);
      lines.push(...formatEventLines(e, 300));
      lines.push('');
    });

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Tool 7: suboculo_get_usage ──────────────────────────────────────────────

server.tool(
  'suboculo_get_usage',
  'Get token usage statistics extracted from session transcripts. Shows totals by session, model, and agent. Usage data is extracted when Task tools complete (triggering transcript analysis).',
  {
    sessionId: z.string().optional().describe('Filter by session ID (default: all sessions)'),
  },
  async ({ sessionId }) => {
    let sql = `SELECT data FROM entries WHERE event = 'usage'`;
    const params = [];

    if (sessionId) {
      sql += ' AND sessionID = ?';
      params.push(sessionId);
    }

    sql += ' ORDER BY ts ASC';
    const rows = db.prepare(sql).all(...params);

    if (rows.length === 0) {
      return {
        content: [{
          type: 'text',
          text: sessionId
            ? `No usage data found for session ${sessionId}. Usage is extracted from transcripts when Task tools complete.`
            : 'No usage data found. Usage is extracted from transcripts when Task tools complete.'
        }]
      };
    }

    // Aggregate by session → model → agent
    const sessions = new Map();
    let grandTotal = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, apiCalls: 0 };

    for (const row of rows) {
      const cep = JSON.parse(row.data);
      const d = cep.data || {};
      const sid = cep.sessionId || 'unknown';
      const model = d.model || 'unknown';
      const agent = d.agentId || 'lead';

      if (!sessions.has(sid)) sessions.set(sid, { models: new Map(), total: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, apiCalls: 0 } });
      const session = sessions.get(sid);

      const modelKey = `${model}::${agent}`;
      if (!session.models.has(modelKey)) session.models.set(modelKey, { model, agent, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, apiCalls: 0 });
      const bucket = session.models.get(modelKey);

      const inp = d.inputTokens || 0;
      const out = d.outputTokens || 0;
      const cc = d.cacheCreationTokens || 0;
      const cr = d.cacheReadTokens || 0;

      bucket.input += inp; bucket.output += out; bucket.cacheCreate += cc; bucket.cacheRead += cr; bucket.apiCalls++;
      session.total.input += inp; session.total.output += out; session.total.cacheCreate += cc; session.total.cacheRead += cr; session.total.apiCalls++;
      grandTotal.input += inp; grandTotal.output += out; grandTotal.cacheCreate += cc; grandTotal.cacheRead += cr; grandTotal.apiCalls++;
    }

    const lines = [];
    lines.push('=== Token Usage ===\n');

    const fmtTokens = (t) => {
      const totalInput = t.input + t.cacheCreate + t.cacheRead;
      const cacheRatio = totalInput > 0 ? ((t.cacheRead / totalInput) * 100).toFixed(1) : '0.0';
      return [
        `  API calls: ${t.apiCalls}`,
        `  Input tokens: ${t.input.toLocaleString()} (non-cached)`,
        `  Output tokens: ${t.output.toLocaleString()}`,
        `  Cache creation: ${t.cacheCreate.toLocaleString()} tokens`,
        `  Cache read: ${t.cacheRead.toLocaleString()} tokens`,
        `  Cache hit ratio: ${cacheRatio}%`,
        `  Total input (all): ${totalInput.toLocaleString()} tokens`,
      ];
    };

    if (sessions.size > 1) {
      lines.push('Grand Total:');
      lines.push(...fmtTokens(grandTotal));
      lines.push('');
    }

    for (const [sid, session] of sessions) {
      lines.push(`Session: ${sid}`);
      lines.push(...fmtTokens(session.total));
      lines.push('');

      // Breakdown by model/agent
      const sorted = [...session.models.values()].sort((a, b) => (b.output + b.cacheCreate) - (a.output + a.cacheCreate));
      for (const b of sorted) {
        const label = b.agent === 'lead' ? b.model : `${b.model} (agent: ${b.agent})`;
        lines.push(`  ${label}:`);
        lines.push(`    ${b.apiCalls} calls | out: ${b.output.toLocaleString()} | cache-create: ${b.cacheCreate.toLocaleString()} | cache-read: ${b.cacheRead.toLocaleString()}`);
      }
      lines.push('');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Tool 8: suboculo_save_analysis ────────────────────────────────────────────

server.tool(
  'suboculo_save_analysis',
  'Save your analysis so it appears in the Suboculo web UI Analyses tab. Call this after analyzing events (from suboculo_get_selection or suboculo_get_session) to persist your analysis for the user to review in the browser.',
  {
    analysis: z.string().describe('Your full analysis text (markdown supported)'),
    event_count: z.number().optional().describe('Number of events that were analyzed'),
    event_keys: z.array(z.string()).optional().describe('Keys of the events that were analyzed'),
    prompt: z.string().optional().describe('The prompt/question the user asked'),
  },
  async ({ analysis, event_count, event_keys, prompt }) => {
    try {
      const port = process.env.SUBOCULO_PORT || '3000';
      const response = await fetch(`http://localhost:${port}/api/analyses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-code-cli',
          event_count: event_count || 0,
          event_keys: event_keys || [],
          analysis,
          prompt: prompt || null,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: response.statusText }));
        return {
          content: [{
            type: 'text',
            text: `Failed to save analysis: ${err.error || response.statusText}. Is the Suboculo web server running? (node .suboculo/backend/server.js)`
          }]
        };
      }

      const result = await response.json();
      return {
        content: [{
          type: 'text',
          text: `Analysis saved (ID: ${result.analysisId}). It is now visible in the Suboculo web UI under the Analyses tab.`
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `Failed to save analysis: ${err.message}. Make sure the Suboculo web server is running (node .suboculo/backend/server.js).`
        }]
      };
    }
  }
);

// ── Tool 9: suboculo_get_reliability_kpis ───────────────────────────────────

server.tool(
  'suboculo_get_reliability_kpis',
  'Get reliability KPI snapshot over task runs (success, retry, intervention, cost, duration) with optional filters.',
  {
    runner: z.string().optional().describe('Filter by runner'),
    source: z.string().optional().describe('Filter by task run source (e.g. "derived_attempt")'),
    status: z.string().optional().describe('Filter by task run status'),
    canonical_outcome_label: z.string().optional().describe('Filter by canonical outcome label'),
    failure_mode: z.string().optional().describe('Filter by canonical failure mode'),
    failure_subtype: z.string().optional().describe('Filter by canonical failure subtype'),
    requires_human_intervention: z.enum(['true', 'false']).optional().describe('Filter by canonical intervention flag'),
    from: z.string().optional().describe('Lower timestamp bound (ISO)'),
    to: z.string().optional().describe('Upper timestamp bound (ISO)'),
  },
  async (input) => {
    try {
      const query = buildQueryParams(input, [
        'runner', 'source', 'status', 'canonical_outcome_label',
        'failure_mode', 'failure_subtype', 'requires_human_intervention',
        'from', 'to'
      ]);
      const payload = await callBackendJson('/api/reliability/kpis', { query });
      return toMcpText(payload, '=== Reliability KPIs ===');
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed to fetch reliability KPIs: ${err.message}` }] };
    }
  }
);

// ── Tool 10: suboculo_get_reliability_trends ────────────────────────────────

server.tool(
  'suboculo_get_reliability_trends',
  'Get time-bucketed reliability trends and trend insights. Includes by-runner breakdown and significance guards.',
  {
    runner: z.string().optional().describe('Filter by runner'),
    source: z.string().optional().describe('Filter by task run source (e.g. "derived_attempt")'),
    status: z.string().optional().describe('Filter by task run status'),
    canonical_outcome_label: z.string().optional().describe('Filter by canonical outcome label'),
    from: z.string().optional().describe('Lower timestamp bound (ISO)'),
    to: z.string().optional().describe('Upper timestamp bound (ISO)'),
    bucket: z.enum(['day', 'week']).default('day').describe('Trend bucket size'),
    window_days: z.number().min(1).max(365).default(30).describe('Default lookback window in days'),
  },
  async (input) => {
    try {
      const query = buildQueryParams(input, [
        'runner', 'source', 'status', 'canonical_outcome_label',
        'from', 'to', 'bucket', 'window_days'
      ]);
      const [trends, insights] = await Promise.all([
        callBackendJson('/api/reliability/trends', { query }),
        callBackendJson('/api/reliability/trends/insights', { query })
      ]);
      return toMcpText({ trends, insights }, '=== Reliability Trends ===');
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed to fetch reliability trends: ${err.message}` }] };
    }
  }
);

// ── Tool 11: suboculo_get_failure_mode_trends ───────────────────────────────

server.tool(
  'suboculo_get_failure_mode_trends',
  'Get time-bucketed canonical failure-mode mix trends, including top modes per bucket.',
  {
    runner: z.string().optional().describe('Filter by runner'),
    source: z.string().optional().describe('Filter by task run source (e.g. "derived_attempt")'),
    status: z.string().optional().describe('Filter by task run status'),
    from: z.string().optional().describe('Lower timestamp bound (ISO)'),
    to: z.string().optional().describe('Upper timestamp bound (ISO)'),
    bucket: z.enum(['day', 'week']).default('day').describe('Trend bucket size'),
    window_days: z.number().min(1).max(365).default(30).describe('Default lookback window in days'),
  },
  async (input) => {
    try {
      const query = buildQueryParams(input, [
        'runner', 'source', 'status', 'from', 'to', 'bucket', 'window_days'
      ]);
      const payload = await callBackendJson('/api/reliability/trends/failure-modes', { query });
      return toMcpText(payload, '=== Failure Mode Trends ===');
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed to fetch failure-mode trends: ${err.message}` }] };
    }
  }
);

// ── Tool 12: suboculo_get_task_run_after_action_report ──────────────────────

server.tool(
  'suboculo_get_task_run_after_action_report',
  'Generate and return an after-action report for a specific task run ID.',
  {
    task_run_id: z.number().int().positive().describe('Task run ID'),
  },
  async ({ task_run_id }) => {
    try {
      const payload = await callBackendJson(`/api/task-runs/${task_run_id}/after-action-report`);
      return toMcpText(payload, `=== After-Action Report (task_run_id=${task_run_id}) ===`);
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed to fetch after-action report: ${err.message}` }] };
    }
  }
);

// ── Tool 13: suboculo_record_task_run_outcome ───────────────────────────────

server.tool(
  'suboculo_record_task_run_outcome',
  'Record an outcome for a task run (supports canonical outcomes and failure taxonomy fields).',
  {
    task_run_id: z.number().int().positive().describe('Task run ID'),
    evaluation_type: z.enum(['human', 'rule_based', 'llm_judge', 'benchmark_checker']).describe('Evaluation source'),
    outcome_label: z.enum(['success', 'partial_success', 'failure', 'unsafe_success', 'interrupted', 'abandoned', 'unknown']).describe('Outcome label'),
    correctness_score: z.number().min(0).max(1).optional(),
    safety_score: z.number().min(0).max(1).optional(),
    efficiency_score: z.number().min(0).max(1).optional(),
    reproducibility_score: z.number().min(0).max(1).optional(),
    requires_human_intervention: z.boolean().optional(),
    failure_mode: z.string().optional(),
    failure_subtype: z.string().optional(),
    notes: z.string().optional(),
    evaluator: z.string().optional(),
    evidence: z.any().optional(),
    is_canonical: z.boolean().optional(),
  },
  async (input) => {
    try {
      const { task_run_id, ...payload } = input;
      const result = await callBackendJson(`/api/task-runs/${task_run_id}/outcomes`, {
        method: 'POST',
        body: payload
      });
      return toMcpText(result, `Outcome recorded for task run ${task_run_id}`);
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed to record outcome: ${err.message}` }] };
    }
  }
);

// ── Start server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[suboculo-mcp] Server started on stdio');
}

main().catch(err => {
  console.error('[suboculo-mcp] Fatal error:', err);
  process.exit(1);
});
