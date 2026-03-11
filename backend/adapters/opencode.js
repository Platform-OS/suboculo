/**
 * OpenCode to CEP Adapter
 *
 * Translates OpenCode's native log format to Common Event Protocol (CEP).
 *
 * OpenCode Format:
 * - kind: "init", "session.event", "tool.before", "tool.after", "task.spawn", "message.toolpart"
 * - type: Sub-type for session.event (e.g., "session.created", "session.updated")
 * - sessionID: Current session ID
 * - rootSessionID: Root session ID (for subagents)
 * - callID: Unique identifier for tool calls
 * - subagentType: Type of subagent (if applicable)
 */

class OpenCodeAdapter {
  constructor() {
    // Track tool.before events to pair with tool.after
    this.pendingToolCalls = new Map();
  }

  /**
   * Translate a single OpenCode event to CEP format
   * @param {Object} event - OpenCode native event
   * @returns {Object|null} - CEP event or null if should be skipped
   */
  translate(event) {
    if (!event || !event.kind) {
      return null;
    }

    const baseEvent = {
      ts: event.ts,
      runner: 'opencode',
      sessionId: event.sessionID || null,
      parentSessionId: this.getParentSessionId(event),
      data: {},
      meta: {}
    };

    switch (event.kind) {
      case 'init':
        return this.translateInit(event, baseEvent);

      case 'session.event':
        return this.translateSessionEvent(event, baseEvent);

      case 'tool.before':
        return this.translateToolBefore(event, baseEvent);

      case 'tool.after':
        return this.translateToolAfter(event, baseEvent);

      case 'task.spawn':
        return this.translateTaskSpawn(event, baseEvent);

      case 'message.toolpart':
        return this.translateMessage(event, baseEvent);

      default:
        // Unknown event type - pass through as custom
        return {
          ...baseEvent,
          event: 'custom',
          data: event,
          meta: { originalKind: event.kind }
        };
    }
  }

  /**
   * Translate batch of OpenCode events
   * @param {Array} events - Array of OpenCode events
   * @returns {Array} - Array of CEP events
   */
  translateBatch(events) {
    return events
      .map(e => this.translate(e))
      .filter(e => e !== null);
  }

  // --- Individual event translators ---

  translateInit(event, base) {
    return {
      ...base,
      event: 'session.start',
      data: {
        directory: event.directory || null
      },
      meta: {
        debug: event.debug
      }
    };
  }

  translateSessionEvent(event, base) {
    const type = event.type;

    if (type === 'session.created') {
      return {
        ...base,
        event: 'session.start',
        data: {
          title: event.title || null
        }
      };
    }

    if (type === 'session.updated') {
      return {
        ...base,
        event: 'session.update',
        data: {
          title: event.title || null
        }
      };
    }

    // session.status, session.diff, and other types are less important
    // We can skip them or pass as custom events
    if (type === 'session.status' || type === 'session.diff') {
      return null; // Skip these - they're noise
    }

    // Unknown session event type - pass as custom
    return {
      ...base,
      event: 'custom',
      data: event,
      meta: { originalType: type }
    };
  }

  translateToolBefore(event, base) {
    // Store the tool.before event to pair with tool.after later
    if (event.callID) {
      this.pendingToolCalls.set(event.callID, event);
    }

    return {
      ...base,
      event: 'tool.start',
      traceId: event.callID || null,
      data: {
        tool: event.tool || null,
        args: {} // tool.before doesn't have args in OpenCode
      },
      meta: {
        subagentType: event.subagentType || null
      }
    };
  }

  translateToolAfter(event, base) {
    const callID = event.callID;
    const beforeEvent = this.pendingToolCalls.get(callID);

    // Clean up the pending call
    if (callID) {
      this.pendingToolCalls.delete(callID);
    }

    // Determine status based on presence of error or success indicators
    // OpenCode doesn't have explicit status, so we infer it
    const status = this.inferToolStatus(event);

    return {
      ...base,
      event: 'tool.end',
      traceId: callID || null,
      data: {
        tool: event.tool || null,
        args: event.args || {},
        durationMs: event.durationMs || null,
        status: status,
        outputLen: event.outputLen || null,
        outputPreview: event.outputPreview || null
      },
      meta: {
        subagentType: event.subagentType || null
      }
    };
  }

  translateTaskSpawn(event, base) {
    return {
      ...base,
      event: 'subagent.spawn',
      data: {
        childSessionId: event.childSessionID || null,
        subagentType: event.subagentType || null
      },
      meta: {
        parentSessionID: event.parentSessionID || null
      }
    };
  }

  translateMessage(event, base) {
    return {
      ...base,
      event: 'message',
      data: {
        role: 'assistant', // OpenCode tool parts are from assistant
        contentPreview: this.extractContentPreview(event)
      },
      meta: {
        originalKind: 'message.toolpart'
      }
    };
  }

  // --- Helper methods ---

  getParentSessionId(event) {
    // If rootSessionID differs from sessionID, this is a subagent
    if (event.rootSessionID && event.sessionID &&
        event.rootSessionID !== event.sessionID) {
      return event.rootSessionID;
    }
    return null;
  }

  inferToolStatus(event) {
    // OpenCode doesn't provide explicit status
    // We infer based on presence of output or errors

    // If there's an error field (not standard but might exist)
    if (event.error) {
      return 'error';
    }

    // If durationMs exists, assume success
    if (typeof event.durationMs === 'number') {
      return 'success';
    }

    // Default to success
    return 'success';
  }

  extractContentPreview(event) {
    // Extract a preview from message.toolpart events
    if (event.content) {
      return String(event.content).substring(0, 200);
    }
    if (event.text) {
      return String(event.text).substring(0, 200);
    }
    return '';
  }

  /**
   * Reset adapter state (clear pending tool calls)
   */
  reset() {
    this.pendingToolCalls.clear();
  }
}

module.exports = OpenCodeAdapter;
