# Suboculo Backend

Node.js + Express + SQLite backend for the Suboculo AI agent monitoring platform.

## Features

- **SQLite Database** - Persistent event storage
- **Indexed Queries** - Fast filtering and searching
- **REST API** - Query, annotate, and analyze events
- **SSE Streaming** - Real-time event updates
- **CEP Format** - Common Event Protocol for multi-runner support

## Installation

```bash
npm install
```

## Usage

```bash
node server.js
```

Server runs on `http://localhost:3000` (override with `SUBOCULO_PORT`).

## Maintenance Scripts

```bash
npm run smoke
npm run provenance:check
```

`provenance:check` validates model + runner version provenance coverage in recent `entries` and `task_runs` for `claude-code` and `opencode`.

## API Endpoints

### Ingestion
- `POST /api/ingest` - Ingest a single CEP event
- `POST /api/ingest/batch` - Ingest an array of CEP events
- `POST /api/notify` - Emit a single event to SSE clients (no DB write)
- `POST /api/notify/batch` - Emit events to SSE clients (no DB write)

### Query
- `GET /api/entries?page=1&pageSize=100&event=tool.end...` - Get paginated entries
- `GET /api/facets` - Get unique values for filters (runners, events, tools, agents, etc.)
- `GET /api/stats` - Get statistics (total entries, avg duration)

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

### Reliability
- `GET /api/reliability/kpis` - Aggregate KPI snapshot over filtered task runs
- `GET /api/reliability/kpi-definitions` - KPI formulas, denominator rules, and guardrail thresholds
- `GET /api/reliability/kpis/by-runner` - KPI snapshot split by runner over filtered task runs
- `GET /api/reliability/trends` - Time-bucketed KPI trends (`bucket=day|week`, `window_days=N`)

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
```

## File Structure

```
backend/
├── server.js                 # Express server + API
├── cep-processor.js          # CEP event validation and insertion
├── mcp-analytics-server.mjs  # MCP query tools for CLI analysis
└── package.json
```
