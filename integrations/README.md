# Agent Integrations

Client-side integrations that capture events and write them to the per-project Suboculo database.

## Available Integrations

### [Claude Code](./claude-code/)

**Status:** Available
**Type:** Hooks + standalone event writer
**Installation:** `./install-suboculo.sh /path/to/project`

Captures tool usage, agent spawns, and session events from Claude Code via hooks. Events are written directly to SQLite and optionally pushed to SSE via HTTP notify.

[→ Documentation](./claude-code/README.md)

---

### [OpenCode](./opencode/)

**Status:** Available
**Type:** Bun plugin + bun:sqlite
**Installation:** `./install-suboculo-opencode.sh /path/to/project`

Captures tool usage and session events from OpenCode via a Bun plugin. Uses bun:sqlite for direct database writes.

---

### Codex CLI

**Status:** Planned
**Type:** TBD

---

## How Integrations Work

```
┌─────────────────┐
│  Claude Code    │──┐
│  (hooks)        │  │    ┌──────────────┐
└─────────────────┘  │    │              │
                     ├───→│  .suboculo/  │
┌─────────────────┐  │    │  events.db   │
│    OpenCode     │──┘    │              │
│  (Bun plugin)   │      └──────┬───────┘
└─────────────────┘             │
                                ▼
                    ┌──────────────────────┐
                    │  Backend (server.js) │
                    │  serves UI + SSE     │
                    │  + MCP analytics     │
                    └──────────────────────┘
```

All integrations write events using the [Common Event Protocol (CEP)](../backend/CEP-SPEC.md). Each project has its own `.suboculo/` directory with an independent database and backend.

## Creating a New Integration

1. **Create directory**: `integrations/your-agent/`
2. **Implement event capture**: Write to SQLite directly and/or send events to `POST /api/ingest`
3. **Follow CEP format**: See [CEP-SPEC.md](../backend/CEP-SPEC.md)
4. **Create install script**: Copy files to target project's `.suboculo/` directory

### Minimum Event Format

```json
{
  "ts": "2026-03-11T12:00:00Z",
  "event": "tool.start",
  "runner": "your-agent",
  "sessionId": "unique-session-id",
  "traceId": "unique-trace-id",
  "data": {
    "tool": "ToolName",
    "args": {}
  }
}
```
