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
    // Usage events: unique by session + model + agent + timestamp
    if (event.event === 'usage' && event.sessionId) {
      const agent = event.data?.agentId || 'lead';
      const model = event.data?.model || 'unknown';
      return `usage::${event.sessionId}::${model}::${agent}::${event.ts}`;
    }
    // Subagent lifecycle events: use agentId to prevent key collisions
    const agentId = event.data?.agentId;
    if (agentId && event.sessionId && event.event) {
      return `${event.sessionId}::${event.event}::${agentId}::${event.ts}`;
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
      key, ts, cepEvent, tool, sessionId, parentSessionID || sessionId, parentSessionID, durationMs, args, eventData,
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

  // Track session-level agent identity for lifecycle events
  const sessionAgentCache = new Map();
  const lifecycleDedupe = new Map();
  const startedSessions = new Set();
  const spawnedSubagentSessions = new Set();

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

  function resolveSessionId(payload = {}) {
    return (
      payload.sessionID ||
      payload.sessionId ||
      payload.id ||
      payload.session?.id ||
      payload.properties?.id ||
      payload.properties?.sessionID ||
      payload.properties?.sessionId ||
      payload.properties?.info?.id ||
      payload.properties?.info?.sessionID ||
      payload.properties?.info?.sessionId ||
      payload.data?.sessionID ||
      payload.data?.sessionId ||
      payload.data?.id ||
      null
    );
  }

  function resolveSessionTitle(payload = {}) {
    return (
      payload.title ||
      payload.name ||
      payload.sessionTitle ||
      payload.session?.title ||
      payload.properties?.title ||
      payload.properties?.name ||
      payload.properties?.info?.title ||
      payload.properties?.info?.name ||
      payload.data?.title ||
      payload.data?.name ||
      null
    );
  }

  function resolveParentSessionId(payload = {}, ctx = {}) {
    return (
      payload.parentID ||
      payload.parentSessionID ||
      payload.parentSessionId ||
      payload.session?.parentID ||
      payload.session?.parentSessionID ||
      payload.properties?.parentID ||
      payload.properties?.parentSessionID ||
      payload.properties?.parentSessionId ||
      payload.properties?.info?.parentID ||
      payload.properties?.info?.parentSessionID ||
      payload.properties?.info?.parentSessionId ||
      payload.data?.parentID ||
      payload.data?.parentSessionID ||
      payload.data?.parentSessionId ||
      ctx.parentSessionId ||
      null
    );
  }

  function resolveEndReason(input = {}, output = {}) {
    return output.reason || input.reason || output.status || input.status || 'completed';
  }

  function shouldEmitLifecycle(kind, sessionId, ts) {
    const second = String(ts || '').slice(0, 19);
    const key = `${kind}::${sessionId}::${second}`;
    const now = Date.now();

    // Remove stale dedupe entries
    for (const [k, createdAt] of lifecycleDedupe) {
      if (now - createdAt > 30000) lifecycleDedupe.delete(k);
    }

    if (lifecycleDedupe.has(key)) return false;
    lifecycleDedupe.set(key, now);
    return true;
  }

  function maybeEmitSubagentSpawn(ts, sessionId, parentSessionId, agentId, agentType) {
    if (!parentSessionId) return;
    if (spawnedSubagentSessions.has(sessionId)) return;
    spawnedSubagentSessions.add(sessionId);

    insertCEPEvent({
      ts,
      event: 'subagent.spawn',
      runner: 'opencode',
      sessionId: parentSessionId,
      data: {
        agentId: agentId || sessionId,
        agentType: agentType || agentId || 'subagent',
        childSessionId: sessionId
      }
    });
  }

  // Fallback session-start emission for environments where lifecycle hooks are not delivered.
  function ensureSessionStartFromToolContext(sessionId, ctx, input = {}) {
    if (!sessionId || startedSessions.has(sessionId)) return;
    startedSessions.add(sessionId);

    const ts = new Date().toISOString();
    const parentSessionId = input.parentID || input.parentSessionID || input.parentSessionId || ctx.parentSessionId || null;
    const agentId = input.agent || input.agentId || input.data?.agentId || ctx.agentId || null;

    insertCEPEvent({
      ts,
      event: 'session.start',
      runner: 'opencode',
      sessionId,
      parentSessionId,
      data: {
        title: resolveSessionTitle(input),
        directory
      }
    });

    maybeEmitSubagentSpawn(ts, sessionId, parentSessionId, agentId, input.agentType || input.data?.agentType || null);
  }

  async function emitSessionCreatedLifecycle(input = {}) {
    const ts = new Date().toISOString();
    const sessionId = resolveSessionId(input);
    if (!sessionId) return;
    if (!shouldEmitLifecycle('session.created', sessionId, ts)) return;
    startedSessions.add(sessionId);

    const ctx = await getSessionContext(sessionId);
    const parentSessionId = resolveParentSessionId(input, ctx);
    const agentId = input.agent || input.agentId || input.data?.agentId || ctx.agentId || null;
    if (agentId) sessionAgentCache.set(sessionId, agentId);

    insertCEPEvent({
      ts,
      event: 'session.start',
      runner: 'opencode',
      sessionId,
      parentSessionId,
      data: {
        title: resolveSessionTitle(input),
        directory: input.directory || input.session?.directory || input.properties?.info?.directory || directory
      }
    });

    maybeEmitSubagentSpawn(ts, sessionId, parentSessionId, agentId, input.agentType || input.data?.agentType || null);
  }

  async function emitSessionDeletedLifecycle(input = {}, output = {}) {
    const ts = new Date().toISOString();
    const sessionId = resolveSessionId(input);
    if (!sessionId) return;
    if (!shouldEmitLifecycle('session.deleted', sessionId, ts)) return;

    const parentSessionId = resolveParentSessionId(input, { parentSessionId: parentCache.get(sessionId) || null });
    const cachedAgentId = sessionAgentCache.get(sessionId) || null;
    const reason = resolveEndReason(input, output || {});

    insertCEPEvent({
      ts,
      event: 'session.end',
      runner: 'opencode',
      sessionId,
      parentSessionId,
      data: {
        title: resolveSessionTitle(input),
        reason
      }
    });

    if (parentSessionId) {
      insertCEPEvent({
        ts,
        event: 'subagent.stop',
        runner: 'opencode',
        sessionId: parentSessionId,
        data: {
          agentId: cachedAgentId || sessionId,
          agentType: input.agentType || input.data?.agentType || cachedAgentId || 'subagent',
          childSessionId: sessionId,
          reason
        }
      });
    }

    parentCache.delete(sessionId);
    lastUsageTotals.delete(sessionId);
    sessionAgentCache.delete(sessionId);
    startedSessions.delete(sessionId);
    spawnedSubagentSessions.delete(sessionId);
  }

  return {
    // Capture session lifecycle start
    "session.created": async (input, output) => {
      try {
        debugLog('Hook fired: session.created', { input });
        await emitSessionCreatedLifecycle(input);
      } catch (err) {
        debugLog('Failed to insert session.created lifecycle events:', err.message);
      }
    },

    // Capture session lifecycle end
    "session.deleted": async (input, output) => {
      try {
        debugLog('Hook fired: session.deleted', { input, output });
        await emitSessionDeletedLifecycle(input, output);
      } catch (err) {
        debugLog('Failed to insert session.deleted lifecycle events:', err.message);
      }
    },

    // Fallback path for OpenCode versions/configurations that surface lifecycle
    // updates through the generic event stream.
    event: async (input, output) => {
      try {
        const payload =
          input?.event ||
          input?.data?.event ||
          input?.payload ||
          input;
        const eventType = payload?.type || payload?.kind || input?.type || input?.kind;
        if (!eventType) return;

        if (typeof eventType === 'string' && eventType.startsWith('session.')) {
          debugLog(`Hook fired: event(${eventType})`, { input, output });
        }

        if (eventType === 'session.created' || eventType === 'session.started') {
          await emitSessionCreatedLifecycle(payload);
        } else if (
          eventType === 'session.deleted' ||
          eventType === 'session.ended' ||
          eventType === 'session.closed' ||
          eventType === 'session.destroyed' ||
          eventType === 'session.completed'
        ) {
          await emitSessionDeletedLifecycle(payload, output || payload?.output || {});
        } else if (eventType === 'session.updated') {
          // Intentionally ignored for now:
          // title/status churn is noisy and not essential for current analysis workflows.
        } else if (eventType === 'session.status') {
          // Intentionally ignored:
          // "busy"/"idle" are transient states and not reliable session boundaries.
        } else if (eventType === 'session.idle') {
          // Intentionally ignored:
          // OpenCode reuses session IDs after idle, so treating this as end creates
          // false session.end -> session.start pairs for the same session.
        }
      } catch (err) {
        debugLog('Failed to process generic lifecycle event:', err.message);
      }
    },

    // Capture tool execution start
    "tool.execute.before": async (input, output) => {
      const ts = new Date().toISOString();
      const traceId = input.callID || `call_${Date.now()}`;

      // Store start time for duration calculation
      toolStartTimes.set(traceId, Date.now());

      // Get session context
      const ctx = await getSessionContext(input.sessionID);
      if (ctx.agentId) sessionAgentCache.set(input.sessionID, ctx.agentId);
      ensureSessionStartFromToolContext(input.sessionID, ctx, input);

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
      if (ctx.agentId) sessionAgentCache.set(input.sessionID, ctx.agentId);
      ensureSessionStartFromToolContext(input.sessionID, ctx, input);

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
