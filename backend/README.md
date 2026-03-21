# Suboculo Backend

Node.js + Express + SQLite backend for the Suboculo AI agent monitoring platform.

## Features

- **SQLite Database** - Persistent event storage
- **Indexed Queries** - Fast filtering and searching
- **REST API** - Query, annotate, and analyze events
- **SSE Streaming** - Real-time event updates
- **CEP Format** - Common Event Protocol for multi-runner support
- **Attempt-based Task Runs** - Derived reliability unit above raw events
- **Outcome Semantics** - Structured, validated outcome recording
- **Benchmark Entities** - Definitions, runs, and case-level result tracking

## Installation

```bash
npm install
```

## Usage

```bash
node server.js
```

Server runs on `http://localhost:3000` (override with `SUBOCULO_PORT`).

## API Endpoints

### Ingestion
- `POST /api/ingest` - Ingest a single CEP event
- `POST /api/ingest/batch` - Ingest an array of CEP events
- `POST /api/notify` - Emit a single event to SSE clients (no DB write)
- `POST /api/notify/batch` - Emit events to SSE clients (no DB write)

### Query
- `GET /api/entries?page=1&pageSize=100&event=tool.end...` - Get paginated entries (supports attempt filter via `attempt=task_key`)
- `GET /api/facets` - Get unique values for filters (runners, events, tools, agents, attempts, etc.)
- `GET /api/stats` - Get statistics (total entries, avg duration)

### Task Runs & Outcomes
- `POST /api/task-runs/derive` - Derive/backfill task runs from events
- `GET /api/task-runs` - List task runs with filters/pagination
- `GET /api/task-runs/:id` - Get task run detail with linked events and outcomes
- `POST /api/task-runs/:id/outcomes` - Record structured outcome for a task run
- `GET /api/task-runs/outcome-summary` - Aggregate outcome/failure summaries
- `GET /api/meta/outcome-taxonomy` - Allowed values for outcome form fields

### Benchmarks
- `GET /api/benchmarks`
- `POST /api/benchmarks`
- `GET /api/benchmarks/:id`
- `POST /api/benchmarks/:id/cases`
- `POST /api/benchmarks/:id/runs`
- `GET /api/benchmark-runs/:id`
- `POST /api/benchmark-runs/:id/cases/:caseId/result`

### Real-Time
- `GET /api/events/stream` - SSE stream of new events

### Tags & Notes
- `GET /api/tags` - Get all tags
- `POST /api/tags` - Add/remove tag `{entryKey, tag, action: "add"|"remove"}`
- `GET /api/notes` - Get all notes
- `POST /api/notes` - Set note `{entryKey, note}`

### Import/Export
- `GET /api/export` - Export tags and notes as JSON
- `POST /api/import` - Import tags and notes `{tagsByKey, notesByKey}`

### Analysis
- `POST /api/analyze` - Analyze events via Anthropic API `{keys, apiKey, model, prompt}`
- `POST /api/analyses` - Save an analysis result
- `GET /api/analyses-history` - List saved analyses
- `GET /api/analyses-history/:id` - Get a specific analysis
- `DELETE /api/analyses-history/:id` - Delete an analysis

### Selection
- `POST /api/selection` - Save selected event keys for CLI analysis
- `GET /api/selection` - Get current selection

## Database Schema

```sql
entries (
  key TEXT PRIMARY KEY,
  ts, kind, type, tool,
  sessionID, rootSessionID, subagentType, agentId,
  callID, durationMs, args, data,
  runner, event, traceId, status
)

tags (entry_key, tag)
notes (entry_key, note)
analyses (id, timestamp, model, event_count, event_keys, analysis, prompt)
task_runs (...)
task_run_events (task_run_id, entry_key)
outcomes (...)
benchmarks (...)
benchmark_cases (...)
benchmark_runs (...)
benchmark_run_cases (...)
```

## Operational Notes

- Server binds to `127.0.0.1` by default (`SUBOCULO_HOST` to override).
- Attempt derivation is the canonical mode (`source=derived_attempt`).
- Optional cleanup of legacy root-session rows:

```bash
npm run cleanup:legacy-runs
```

## File Structure

```
backend/
├── server.js                 # Express server + API
├── cep-processor.js          # CEP event validation and insertion
├── mcp-analytics-server.mjs  # MCP query tools for CLI analysis
└── package.json
```
