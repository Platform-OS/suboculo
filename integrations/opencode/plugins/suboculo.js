/**
 * Suboculo Plugin for OpenCode
 *
 * Captures tool execution, session lifecycle, and other events
 * and writes them to a local SQLite database as CEP events.
 *
 * Installation:
 * 1. Copy this file to .opencode/plugins/suboculo.js in your project
 * 2. Restart OpenCode (no dependencies needed - uses built-in bun:sqlite)
 */

import { Database } from 'bun:sqlite';
import { join } from 'path';
import { mkdirSync, existsSync, appendFileSync } from 'fs';

export const SuboculoPlugin = async ({ project, client, directory, worktree }) => {
  const LOG_FILE = join(directory, '.suboculo', 'plugin-debug.log');

  function debugLog(message, data = null) {
    try {
      const timestamp = new Date().toISOString();
      let logLine = `[${timestamp}] ${message}`;
      if (data !== null) {
        logLine += '\n' + JSON.stringify(data, null, 2);
      }
      appendFileSync(LOG_FILE, logLine + '\n');
    } catch (err) {
      // Ignore logging errors
    }
  }

  // Database setup
  const DB_DIR = join(directory, '.suboculo');
  const DB_PATH = join(DB_DIR, 'events.db');

  // Ensure .suboculo directory exists
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  // Open/create database (bun:sqlite)
  let db;
  try {
    db = new Database(DB_PATH, { create: true });
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (err) {
    debugLog('Failed to open database:', err.message);
    throw err;
  }

  // Initialize schema
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

  // Helper: Generate unique key for CEP event
  function generateCEPKey(event) {
    if (event.traceId && event.event) {
      return `${event.traceId}::${event.event}::${event.ts}`;
    }
    if (event.sessionId && event.event && event.ts) {
      return `${event.sessionId}::${event.event}::${event.ts}`;
    }
    return `${event.ts}::0`;
  }

  // Notify port for SSE real-time updates
  const NOTIFY_PORT = 3000;

  // Helper: Notify web server for SSE (fire-and-forget)
  function notifySSE(event) {
    try {
      fetch(`http://localhost:${NOTIFY_PORT}/api/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(2000)
      }).catch(() => {}); // Ignore errors - server may not be running
    } catch (err) {
      // Ignore - SSE notification is optional
    }
  }

  // Helper: Insert CEP event into database
  function insertCEPEvent(event) {
    const key = generateCEPKey(event);

    const ts = event.ts || null;
    const cepEvent = event.event || null;
    const runner = event.runner || null;
    const sessionId = event.sessionId || null;
    const traceId = event.traceId || null;

    const data = event.data || {};
    const tool = data.tool || null;
    const durationMs = data.durationMs || null;
    const status = data.status || null;
    const args = data.args ? JSON.stringify(data.args) : null;
    const agentId = data.agentId || null;
    const parentSessionID = data.parentSessionId || null;

    const eventData = JSON.stringify(event);

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO entries
      (key, ts, kind, tool, sessionID, rootSessionID, parentSessionID, durationMs, args, data,
       runner, event, traceId, status, agentId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      key, ts, cepEvent, tool, sessionId, sessionId, parentSessionID, durationMs, args, eventData,
      runner, cepEvent, traceId, status, agentId
    );

    // Notify SSE for real-time frontend updates
    notifySSE(event);

    return key;
  }

  // Track tool execution start times for duration calculation
  const toolStartTimes = new Map();

  // Cache parentSessionId per session (doesn't change)
  const parentCache = new Map();

  // Track cumulative token usage per session for delta calculation
  const lastUsageTotals = new Map();

  // Helper: Get session context (agent, parent, messages)
  async function getSessionContext(sessionID) {
    try {
      // Get parentSessionId (cached - doesn't change)
      let parentSessionId = null;
      if (parentCache.has(sessionID)) {
        parentSessionId = parentCache.get(sessionID);
      } else {
        const sessionResp = await client.session.get({ path: { id: sessionID } });
        parentSessionId = sessionResp.data?.parentID || null;
        parentCache.set(sessionID, parentSessionId);
      }

      // Get messages (used for both agent detection and token usage)
      let agentId = null;
      const messagesResp = await client.session.messages({ path: { id: sessionID } });
      const messages = messagesResp.data || [];

      if (messages.length > 0) {
        // Find the last user message (has the current agent)
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i].info;
          if (msg?.role === 'user' && msg?.agent) {
            agentId = msg.agent;
            break;
          }
        }
      }

      return { agentId, parentSessionId, messages };
    } catch (err) {
      debugLog(`Failed to get session info for ${sessionID}: ${err.message}`);
      return { agentId: null, parentSessionId: null, messages: [] };
    }
  }

  // Helper: Extract delta token usage from session messages
  // Returns null if no new usage, otherwise returns the delta since last check
  function extractNewUsage(messages, sessionID) {
    let input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, cost = 0;

    for (const msg of messages) {
      const info = msg.info;
      if (info?.role === 'assistant' && info?.tokens) {
        const t = info.tokens;
        input += t.input || 0;
        output += t.output || 0;
        reasoning += t.reasoning || 0;
        cacheRead += t.cache?.read || 0;
        cacheWrite += t.cache?.write || 0;
        cost += info.cost || 0;
      }
    }

    const prev = lastUsageTotals.get(sessionID) || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

    const delta = {
      input: input - prev.input,
      output: output - prev.output,
      reasoning: reasoning - prev.reasoning,
      cacheRead: cacheRead - prev.cacheRead,
      cacheWrite: cacheWrite - prev.cacheWrite,
      cost: +(cost - prev.cost).toFixed(6),
    };

    // Only emit if there's actual new usage
    if (delta.input === 0 && delta.output === 0 && delta.reasoning === 0 &&
        delta.cacheRead === 0 && delta.cacheWrite === 0) {
      return null;
    }

    lastUsageTotals.set(sessionID, { input, output, reasoning, cacheRead, cacheWrite, cost });
    return delta;
  }

  return {
    // Capture tool execution start
    "tool.execute.before": async (input, output) => {
      const ts = new Date().toISOString();
      const traceId = input.callID || `call_${Date.now()}`;

      // Store start time for duration calculation
      toolStartTimes.set(traceId, Date.now());

      // Get session context
      const ctx = await getSessionContext(input.sessionID);

      try {
        insertCEPEvent({
          ts,
          event: 'tool.start',
          runner: 'opencode',
          sessionId: input.sessionID,
          traceId,
          data: {
            tool: input.tool,
            args: input.args || {},
            agentId: ctx.agentId,
            parentSessionId: ctx.parentSessionId
          }
        });
      } catch (err) {
        debugLog('Failed to insert tool.start event:', err.message);
      }
    },

    // Capture tool execution completion
    "tool.execute.after": async (input, output) => {
      const ts = new Date().toISOString();
      const traceId = input.callID || `call_${Date.now()}`;

      // Calculate duration
      const startTime = toolStartTimes.get(traceId);
      const durationMs = startTime ? Date.now() - startTime : null;
      toolStartTimes.delete(traceId);

      // Get session context (includes messages for both agent detection and usage)
      const ctx = await getSessionContext(input.sessionID);

      try {
        const eventData = {
          tool: input.tool,
          status: output.error ? 'error' : 'success',
          args: input.args || {},
          response: output.error ? output.error : output.output,
          durationMs,
          agentId: ctx.agentId,
          parentSessionId: ctx.parentSessionId
        };

        // Embed token usage delta directly in tool.end event
        const usage = extractNewUsage(ctx.messages, input.sessionID);
        if (usage) {
          eventData.inputTokens = usage.input;
          eventData.outputTokens = usage.output;
          eventData.reasoningTokens = usage.reasoning;
          eventData.cacheCreationTokens = usage.cacheWrite;
          eventData.cacheReadTokens = usage.cacheRead;
          eventData.cost = usage.cost;
        }

        insertCEPEvent({
          ts,
          event: 'tool.end',
          runner: 'opencode',
          sessionId: input.sessionID,
          traceId,
          data: eventData
        });
      } catch (err) {
        debugLog('Failed to insert tool.end event:', err.message);
      }
    },

    // Capture permission requests
    // Input: Permission object with { id, title, description, metadata, sessionID }
    // Output: { status: "ask" | "deny" | "allow" }
    "permission.ask": async (input, output) => {
      const ts = new Date().toISOString();

      try {
        insertCEPEvent({
          ts,
          event: 'message',
          runner: 'opencode',
          sessionId: input.sessionID,
          data: {
            type: 'permission.ask',
            title: input.title,
            description: input.description,
            status: output.status
          }
        });
      } catch (err) {
        debugLog('Failed to insert permission.ask event:', err.message);
      }
    }
  };
};
