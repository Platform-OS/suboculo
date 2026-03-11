# Common Event Protocol (CEP) Specification

Version: 1.0.0

## Overview

The Common Event Protocol (CEP) is a universal event schema for monitoring agent actions across different runners (OpenCode, Claude Code, Aider, etc.). It provides a standardized way to represent agent events for logging, analysis, and visualization.

## Event Types

### `session.start`
Emitted when an agent session begins.

**Required data fields:**
- `title` (string, optional): Session title
- `directory` (string, optional): Working directory

**Example:**
```json
{
  "ts": "2026-03-05T12:00:00.000Z",
  "event": "session.start",
  "runner": "opencode",
  "sessionId": "ses_abc123",
  "parentSessionId": null,
  "data": {
    "title": "Build a web scraper",
    "directory": "/home/user/projects/scraper"
  }
}
```

### `session.end`
Emitted when an agent session ends.

**Required data fields:**
- `title` (string, optional): Final session title
- `reason` (string, optional): Reason for ending (e.g., "completed", "user_cancelled", "error")

### `session.update`
Emitted when session metadata changes (e.g., title update).

**Required data fields:**
- `title` (string): Updated session title

### `tool.start`
Emitted when a tool invocation begins.

**Required data fields:**
- `tool` (string): Tool name (e.g., "read", "write", "bash")
- `args` (object): Tool arguments

**Example:**
```json
{
  "ts": "2026-03-05T12:00:01.000Z",
  "event": "tool.start",
  "runner": "claude-code",
  "sessionId": "ses_abc123",
  "traceId": "call_read_1",
  "data": {
    "tool": "read",
    "args": {
      "filePath": "/home/user/projects/scraper/main.py"
    }
  }
}
```

### `tool.end`
Emitted when a tool invocation completes.

**Required data fields:**
- `tool` (string): Tool name
- `args` (object): Tool arguments (same as tool.start)
- `durationMs` (number): Execution duration in milliseconds
- `status` (string): One of "success", "error", "timeout", "cancelled"
- `outputLen` (number, optional): Length of output
- `outputPreview` (string, optional): Preview of output

**Example:**
```json
{
  "ts": "2026-03-05T12:00:01.042Z",
  "event": "tool.end",
  "runner": "claude-code",
  "sessionId": "ses_abc123",
  "traceId": "call_read_1",
  "data": {
    "tool": "read",
    "args": {
      "filePath": "/home/user/projects/scraper/main.py"
    },
    "durationMs": 42,
    "status": "success",
    "outputLen": 1024,
    "outputPreview": "import requests\nfrom bs4 import Beautiful..."
  }
}
```

### `message`
Emitted when the LLM produces a message.

**Required data fields:**
- `role` (string): One of "user", "assistant", "system"
- `contentPreview` (string): Preview of message content

### `error`
Emitted when an error occurs.

**Required data fields:**
- `message` (string): Error message
- `code` (string, optional): Error code

### `subagent.spawn`
Emitted when a subagent is created.

**Required data fields:**
- `childSessionId` (string): ID of the spawned subagent session
- `subagentType` (string): Type of subagent (e.g., "librarian", "explorer")

### `custom`
Catch-all for runner-specific events that don't fit standard types.

**Required data fields:**
- Any fields in `data` object
- Runner should document custom event structure

## Fields

### Core Fields (Required)

- **`ts`** (string, ISO 8601): Timestamp of when the event occurred
- **`event`** (string): Event type (see Event Types above)
- **`runner`** (string): Name of the agent runner (e.g., "opencode", "claude-code", "aider")

### Session Fields (Optional but Recommended)

- **`sessionId`** (string): Unique identifier for the current session
- **`parentSessionId`** (string | null): Parent session ID if this is a subagent

### Tracing Fields (Optional)

- **`traceId`** (string): Identifier for tracing related events (e.g., pairing tool.start with tool.end)

### Payload Fields

- **`data`** (object): Event-specific data (see Event Types for structure)
- **`meta`** (object): Additional runner-specific metadata (optional, not indexed)

## Adapter Guidelines

When building an adapter to translate from a native runner format to CEP:

1. **Preserve timestamps**: Use the runner's original timestamp if available
2. **Generate IDs consistently**: Ensure sessionId and traceId are stable across related events
3. **Map status codes**: Translate runner-specific status to CEP status enum
4. **Preserve original data**: Put runner-specific fields in `meta` object
5. **Pair events**: For tool.start/tool.end, use the same `traceId`

## Ingestion Methods

### HTTP API (Real-time)

**Single event:**
```
POST /api/ingest
Content-Type: application/json

{
  "ts": "2026-03-05T12:00:00.000Z",
  "event": "tool.end",
  ...
}
```

**Batch events:**
```
POST /api/ingest/batch
Content-Type: application/json

[
  { "ts": "...", "event": "session.start", ... },
  { "ts": "...", "event": "tool.start", ... },
  ...
]
```

### File Upload (Offline)

Upload a JSONL file where each line is a CEP-formatted JSON object:

```
{"ts":"2026-03-05T12:00:00.000Z","event":"session.start",...}
{"ts":"2026-03-05T12:00:01.000Z","event":"tool.start",...}
{"ts":"2026-03-05T12:00:01.042Z","event":"tool.end",...}
```

## Examples

See `examples/` directory for complete event sequences from different runners.

## Version History

- **1.0.0** (2026-03-05): Initial specification
