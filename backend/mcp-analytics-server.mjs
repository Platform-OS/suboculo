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

const server = new McpServer({
  name: 'suboculo',
  version: '0.1.0',
});

// ── Tool 1: suboculo_get_facets ─────────────────────────────────────────────

server.tool(
  'suboculo_get_facets',
  'List available runners, event types, tools, and sessions in the Suboculo database. Use this first to discover what data exists.',
  {},
  async () => {
    const runners = db.prepare('SELECT DISTINCT runner FROM entries WHERE runner IS NOT NULL ORDER BY runner').all();
    const events = db.prepare('SELECT DISTINCT event FROM entries WHERE event IS NOT NULL ORDER BY event').all();
    const tools = db.prepare('SELECT DISTINCT tool FROM entries WHERE tool IS NOT NULL ORDER BY tool').all();
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

    lines.push('\nRecent sessions:');
    recentSessions.forEach(s => {
      lines.push(`  ${s.sessionID}`);
      lines.push(`    Runner: ${s.runner || 'unknown'}`);
      lines.push(`    Started: ${s.started}`);
      lines.push(`    Last event: ${s.lastEvent}`);
      lines.push(`    Events: ${s.eventCount}`);
    });

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
    search: z.string().optional().describe('Text search across args, output preview, and title'),
    since: z.string().optional().describe('Only events after this ISO timestamp (e.g. "2026-03-11T14:00:00Z")'),
    until: z.string().optional().describe('Only events before this ISO timestamp (e.g. "2026-03-11T15:00:00Z")'),
    limit: z.number().min(1).max(200).default(50).describe('Max events to return (default 50)'),
    offset: z.number().min(0).default(0).describe('Offset for pagination (default 0)'),
    sort: z.enum(['asc', 'desc']).default('desc').describe('Sort by timestamp (default desc = newest first)'),
  },
  async ({ runner, tool, event, sessionId, search, since, until, limit, offset, sort }) => {
    let sql = 'SELECT key, ts, event, runner, tool, sessionID, traceId, durationMs, data FROM entries WHERE 1=1';
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
      'SELECT key, ts, event, runner, tool, sessionID, traceId, durationMs, data',
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
      const data = JSON.parse(row.data);
      decodeBase64Fields(data.data);
      lines.push(`${offset + i + 1}. [${row.ts}] ${row.event || data.event}`);
      if (row.tool) lines.push(`   Tool: ${row.tool}`);
      if (row.runner) lines.push(`   Runner: ${row.runner}`);
      if (row.sessionID) lines.push(`   Session: ${row.sessionID}`);
      if (row.traceId) lines.push(`   Trace: ${row.traceId}`);
      if (row.durationMs) lines.push(`   Duration: ${row.durationMs}ms`);

      // Show args summary
      const args = data.data?.args;
      if (args) {
        const argsStr = JSON.stringify(args);
        if (argsStr.length <= 200) {
          lines.push(`   Args: ${argsStr}`);
        } else {
          lines.push(`   Args: ${argsStr.substring(0, 200)}...`);
        }
      }

      // Show result/output preview
      const result = data.data?.result || data.data?.outputPreview;
      if (result) {
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        if (resultStr.length <= 200) {
          lines.push(`   Result: ${resultStr}`);
        } else {
          lines.push(`   Result: ${resultStr.substring(0, 200)}...`);
        }
      }

      const status = data.data?.status;
      if (status) lines.push(`   Status: ${status}`);

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
      const data = JSON.parse(row.data);
      decodeBase64Fields(data.data);

      lines.push(`${i + 1}. [${row.ts}] ${row.event || data.event}`);
      if (row.tool) lines.push(`   Tool: ${row.tool}`);
      if (row.traceId) lines.push(`   Trace: ${row.traceId}`);
      if (row.durationMs) lines.push(`   Duration: ${row.durationMs}ms`);

      const args = data.data?.args;
      if (args) {
        const argsStr = JSON.stringify(args);
        if (argsStr.length <= 300) {
          lines.push(`   Args: ${argsStr}`);
        } else {
          lines.push(`   Args: ${argsStr.substring(0, 300)}...`);
        }
      }

      const result = data.data?.result || data.data?.outputPreview;
      if (result) {
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        if (resultStr.length <= 300) {
          lines.push(`   Result: ${resultStr}`);
        } else {
          lines.push(`   Result: ${resultStr.substring(0, 300)}...`);
        }
      }

      const status = data.data?.status;
      if (status) lines.push(`   Status: ${status}`);

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
      lines.push(`${i + 1}. [${e.ts}] ${e.event}`);
      if (e.data?.tool) lines.push(`   Tool: ${e.data.tool}`);
      if (e.runner) lines.push(`   Runner: ${e.runner}`);
      if (e.sessionId) lines.push(`   Session: ${e.sessionId}`);
      if (e.traceId) lines.push(`   Trace: ${e.traceId}`);
      if (e.data?.durationMs) lines.push(`   Duration: ${e.data.durationMs}ms`);
      if (e.data?.status) lines.push(`   Status: ${e.data.status}`);

      const args = e.data?.args;
      if (args) {
        const argsStr = JSON.stringify(args);
        if (argsStr.length <= 300) {
          lines.push(`   Args: ${argsStr}`);
        } else {
          lines.push(`   Args: ${argsStr.substring(0, 300)}...`);
        }
      }

      const result = e.data?.result || e.data?.outputPreview;
      if (result) {
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        if (resultStr.length <= 300) {
          lines.push(`   Result: ${resultStr}`);
        } else {
          lines.push(`   Result: ${resultStr.substring(0, 300)}...`);
        }
      }

      lines.push('');
    });

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Tool 7: suboculo_save_analysis ────────────────────────────────────────────

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
