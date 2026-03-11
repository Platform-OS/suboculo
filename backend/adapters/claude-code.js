/**
 * Claude Code to CEP Adapter
 *
 * Translates Claude Code's event format to Common Event Protocol (CEP).
 *
 * Claude Code Format:
 * Claude Code hooks receive events with structure:
 * - timestamp: ISO 8601 timestamp
 * - event: Event type (tool_call_start, tool_call_end, session_start, etc.)
 * - sessionId: Current session ID
 * - toolName: Tool name (for tool events)
 * - args: Tool arguments
 * - result: Tool result (for tool_call_end)
 * - exitCode: Exit code (for bash tools)
 * - durationMs: Duration in milliseconds
 */

class ClaudeCodeAdapter {
  constructor() {
    // Track tool.start events to pair with tool.end
    this.pendingToolCalls = new Map();
  }

  /**
   * Translate a single Claude Code event to CEP format
   * @param {Object} event - Claude Code native event
   * @returns {Object|null} - CEP event or null if should be skipped
   */
  translate(event) {
    if (!event || !event.event) {
      return null;
    }

    const baseEvent = {
      ts: event.timestamp || event.ts || new Date().toISOString(),
      runner: 'claude-code',
      sessionId: event.sessionId || event.session_id || null,
      parentSessionId: event.parentSessionId || event.parent_session_id || null,
      data: {},
      meta: {}
    };

    // Map Claude Code event types to CEP event types
    switch (event.event) {
      case 'session_start':
      case 'session.start':
        return this.translateSessionStart(event, baseEvent);

      case 'session_end':
      case 'session.end':
        return this.translateSessionEnd(event, baseEvent);

      case 'tool_call_start':
      case 'tool.start':
        return this.translateToolStart(event, baseEvent);

      case 'tool_call_end':
      case 'tool.end':
        return this.translateToolEnd(event, baseEvent);

      case 'message':
        return this.translateMessage(event, baseEvent);

      case 'error':
        return this.translateError(event, baseEvent);

      case 'subagent_spawn':
      case 'subagent.spawn':
        return this.translateSubagentSpawn(event, baseEvent);

      default:
        // Unknown event type - create custom event
        return this.translateCustom(event, baseEvent);
    }
  }

  /**
   * Translate session.start event
   */
  translateSessionStart(event, base) {
    return {
      ...base,
      event: 'session.start',
      data: {
        title: event.title || event.data?.title || null,
        directory: event.directory || event.cwd || event.data?.directory || null,
        model: event.model || event.data?.model || null
      }
    };
  }

  /**
   * Translate session.end event
   */
  translateSessionEnd(event, base) {
    return {
      ...base,
      event: 'session.end',
      data: {
        title: event.title || event.data?.title || null,
        reason: event.reason || event.data?.reason || 'completed'
      }
    };
  }

  /**
   * Translate tool.start event
   */
  translateToolStart(event, base) {
    const traceId = event.traceId || event.trace_id || event.callId || event.call_id || this.generateTraceId(event);

    const cepEvent = {
      ...base,
      event: 'tool.start',
      traceId: traceId,
      data: {
        tool: event.toolName || event.tool_name || event.tool || null,
        args: event.args || event.arguments || {}
      }
    };

    // Store pending tool call for pairing with tool.end
    this.pendingToolCalls.set(traceId, {
      startTime: base.ts,
      tool: cepEvent.data.tool
    });

    return cepEvent;
  }

  /**
   * Translate tool.end event
   */
  translateToolEnd(event, base) {
    const traceId = event.traceId || event.trace_id || event.callId || event.call_id || this.generateTraceId(event);
    const pending = this.pendingToolCalls.get(traceId);

    // Calculate duration if we have the start time
    let durationMs = event.durationMs || event.duration_ms || event.duration || null;
    if (!durationMs && pending?.startTime) {
      const start = new Date(pending.startTime).getTime();
      const end = new Date(base.ts).getTime();
      durationMs = end - start;
    }

    // Determine status
    const status = this.inferToolStatus(event);

    const cepEvent = {
      ...base,
      event: 'tool.end',
      traceId: traceId,
      data: {
        tool: event.toolName || event.tool_name || event.tool || pending?.tool || null,
        args: event.args || event.arguments || {},
        durationMs: durationMs,
        status: status,
        outputLen: event.outputLen || event.output_len || event.resultLen || null,
        outputPreview: event.outputPreview || event.output_preview || this.extractOutputPreview(event)
      }
    };

    // Clean up pending tool call
    this.pendingToolCalls.delete(traceId);

    return cepEvent;
  }

  /**
   * Translate message event
   */
  translateMessage(event, base) {
    return {
      ...base,
      event: 'message',
      data: {
        role: event.role || event.data?.role || 'assistant',
        contentPreview: event.contentPreview || event.content_preview ||
                        event.content?.substring(0, 200) ||
                        event.data?.content?.substring(0, 200) || null
      }
    };
  }

  /**
   * Translate error event
   */
  translateError(event, base) {
    return {
      ...base,
      event: 'error',
      data: {
        message: event.message || event.error || event.data?.message || 'Unknown error',
        code: event.code || event.error_code || event.data?.code || null,
        stack: event.stack || event.data?.stack || null
      }
    };
  }

  /**
   * Translate subagent.spawn event
   */
  translateSubagentSpawn(event, base) {
    return {
      ...base,
      event: 'subagent.spawn',
      data: {
        childSessionId: event.childSessionId || event.child_session_id || event.data?.childSessionId || null,
        subagentType: event.subagentType || event.subagent_type || event.type || event.data?.subagentType || null
      }
    };
  }

  /**
   * Translate custom/unknown event types
   */
  translateCustom(event, base) {
    return {
      ...base,
      event: 'custom',
      data: {
        originalEvent: event.event,
        ...event.data
      }
    };
  }

  /**
   * Infer tool execution status from event data
   */
  inferToolStatus(event) {
    // Explicit status field
    if (event.status) {
      return event.status;
    }

    // Check for error indicators
    if (event.error || event.errorMessage || event.error_message) {
      return 'error';
    }

    // Check exit code (for Bash tool)
    if (event.exitCode !== undefined || event.exit_code !== undefined) {
      const exitCode = event.exitCode !== undefined ? event.exitCode : event.exit_code;
      return exitCode === 0 ? 'success' : 'error';
    }

    // Check for timeout
    if (event.timeout || event.timedOut || event.timed_out) {
      return 'timeout';
    }

    // Check for cancellation
    if (event.cancelled || event.canceled) {
      return 'cancelled';
    }

    // Default to success if we have a result
    if (event.result !== undefined || event.output !== undefined) {
      return 'success';
    }

    // Unknown status
    return null;
  }

  /**
   * Extract output preview from various possible fields
   */
  extractOutputPreview(event) {
    const maxLen = 500;

    const possibleOutputs = [
      event.outputPreview,
      event.output_preview,
      event.result,
      event.output,
      event.data?.output,
      event.data?.result
    ];

    for (const output of possibleOutputs) {
      if (output && typeof output === 'string') {
        return output.substring(0, maxLen);
      }
      if (output && typeof output === 'object') {
        return JSON.stringify(output).substring(0, maxLen);
      }
    }

    return null;
  }

  /**
   * Generate a trace ID for tool calls that don't have one
   */
  generateTraceId(event) {
    const tool = event.toolName || event.tool_name || event.tool || 'unknown';
    const ts = event.timestamp || event.ts || Date.now();
    return `${tool}_${ts}`;
  }

  /**
   * Translate a batch of Claude Code events to CEP format
   * @param {Array} events - Array of Claude Code events
   * @returns {Array} - Array of CEP events (skipped events are filtered out)
   */
  translateBatch(events) {
    if (!Array.isArray(events)) {
      throw new Error('Events must be an array');
    }

    return events
      .map(event => this.translate(event))
      .filter(event => event !== null);
  }

  /**
   * Reset adapter state (clear pending tool calls)
   */
  reset() {
    this.pendingToolCalls.clear();
  }
}

module.exports = ClaudeCodeAdapter;
