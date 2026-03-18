/**
 * CEP Event Processor
 *
 * Handles ingestion of CEP-formatted events into the database.
 */

/**
 * Generate a unique key for a CEP event
 * @param {Object} event - CEP event
 * @param {number} idx - Index in batch
 * @returns {string} - Unique key
 */
function generateCEPKey(event, idx = 0) {
  // Use traceId if available (for tool events)
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
  const agentId = event.data?.agentId;
  if (agentId && event.sessionId && event.event) {
    return `${event.sessionId}::${event.event}::${agentId}::${event.ts}`;
  }

  // Use sessionId + timestamp + event type
  if (event.sessionId && event.event && event.ts) {
    return `${event.sessionId}::${event.event}::${event.ts}`;
  }

  // Fallback to timestamp + index
  return `${event.ts}::${idx}`;
}

/**
 * Insert a CEP event into the database
 * @param {Object} db - SQLite database instance
 * @param {Object} event - CEP event
 * @param {number} idx - Index in batch
 */
function insertCEPEvent(db, event, idx = 0) {
  const key = generateCEPKey(event, idx);

  // Extract fields from CEP event
  const ts = event.ts || null;
  const cepEvent = event.event || null;
  const runner = event.runner || null;
  const sessionId = event.sessionId || null;
  const parentSessionId = event.parentSessionId || null;
  const traceId = event.traceId || null;

  // Extract data fields
  const data = event.data || {};
  const tool = data.tool || null;
  const durationMs = data.durationMs || null;
  const outputLen = data.outputLen || null;
  const outputPreview = data.outputPreview || null;
  const title = data.title || null;
  const subagentType = data.subagentType || null;
  const childSessionId = data.childSessionId || null;
  const agentId = data.agentId || null;
  const args = data.args ? JSON.stringify(data.args) : null;

  // Store complete event as JSON
  const eventData = JSON.stringify(event);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO entries
    (key, ts, kind, type, tool, sessionID, rootSessionID, subagentType,
     callID, durationMs, outputLen, outputPreview, title,
     parentSessionID, childSessionID, args, data,
     runner, event, traceId, status, agentId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Map CEP fields to database schema
  // NEW CEP columns: runner, event, traceId, status
  // Legacy columns: kind (for backward compat with OpenCode native format)
  // kind -> CEP event type (for legacy queries)
  // event -> CEP event type (new standard field)
  // sessionID -> CEP sessionId
  // rootSessionID -> If this is a subagent, store the root, else same as sessionId
  // callID -> CEP traceId (for legacy queries)
  // traceId -> CEP traceId (new standard field)
  // parentSessionID -> CEP parentSessionId

  const rootSessionId = parentSessionId || sessionId; // Root is parent if exists, else current session
  const status = data.status || null; // Extract status from tool.end events

  stmt.run(
    key,
    ts,
    cepEvent,           // kind = CEP event type (for backward compat)
    null,               // type (not used in CEP)
    tool,
    sessionId,
    rootSessionId,
    subagentType,
    traceId,            // callID = traceId (for backward compat)
    durationMs,
    outputLen,
    outputPreview,
    title,
    parentSessionId,
    childSessionId,
    args,
    eventData,
    runner,             // NEW: CEP runner field
    cepEvent,           // NEW: CEP event field
    traceId,            // NEW: CEP traceId field
    status,             // NEW: CEP status field (from tool.end events)
    agentId             // NEW: agent/subagent attribution
  );

  return key;
}

/**
 * Insert multiple CEP events in a transaction
 * @param {Object} db - SQLite database instance
 * @param {Array} events - Array of CEP events
 * @returns {number} - Number of events inserted
 */
function insertCEPEventsBatch(db, events) {
  const insertMany = db.transaction((eventList) => {
    let count = 0;
    for (let i = 0; i < eventList.length; i++) {
      try {
        insertCEPEvent(db, eventList[i], i);
        count++;
      } catch (err) {
        console.error(`Failed to insert event ${i}:`, err.message);
      }
    }
    return count;
  });

  return insertMany(events);
}

/**
 * Validate a CEP event against the schema
 * @param {Object} event - Event to validate
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
function validateCEPEvent(event) {
  const errors = [];

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { valid: false, errors: ['Event must be a JSON object'] };
  }

  // Required fields
  if (!event.ts) errors.push('Missing required field: ts');
  if (!event.event) errors.push('Missing required field: event');
  if (!event.runner) errors.push('Missing required field: runner');

  // Validate event type
  const validEvents = [
    'session.start',
    'session.end',
    'session.update',
    'tool.start',
    'tool.end',
    'message',
    'error',
    'subagent.spawn',
    'subagent.stop',
    'usage',
    'custom'
  ];
  if (event.event && !validEvents.includes(event.event)) {
    errors.push(`Invalid event type: ${event.event}`);
  }

  // Validate timestamp format (basic check)
  if (event.ts && !/^\d{4}-\d{2}-\d{2}T/.test(event.ts)) {
    errors.push('Invalid timestamp format (expected ISO 8601)');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  generateCEPKey,
  insertCEPEvent,
  insertCEPEventsBatch,
  validateCEPEvent
};
