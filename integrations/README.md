# Agent Integrations

Client-side integrations that send events to the Agent Actions Viewer backend.

## Available Integrations

### [Claude Code](./claude-code/)

**Status:** ✅ Available
**Type:** Claude Code plugin with hooks
**Installation:** `/plugin install github:your-org/suboculo/integrations/claude-code`

Captures all tool usage, agent spawns, and session events from Claude Code sessions via hooks.

**Features:**
- Real-time event capture
- Session tracking
- Tool timing analysis
- Automatic backend sync

[→ Installation Guide](./claude-code/INSTALL.md)
[→ Documentation](./claude-code/README.md)

---

### OpenCode

**Status:** 🚧 Planned
**Type:** TBD (hooks, wrapper script, or API integration)

Support for OpenCode sessions.

---

### Codex CLI

**Status:** 🚧 Planned
**Type:** TBD

Support for Codex CLI sessions.

---

## How Integrations Work

```
┌─────────────────┐
│  Claude Code    │──┐
│  (with plugin)  │  │
└─────────────────┘  │
                     │
┌─────────────────┐  │    ┌──────────────┐    ┌──────────────┐
│    OpenCode     │──┼───→│   Backend    │───→│   Viewer     │
│  (with script)  │  │    │ (localhost   │    │ (localhost   │
└─────────────────┘  │    │    :3000)    │    │    :5173)    │
                     │    └──────────────┘    └──────────────┘
┌─────────────────┐  │
│   Codex CLI     │──┘
│  (with hooks)   │
└─────────────────┘
```

All integrations send events to the same backend using the [Common Event Protocol (CEP)](../backend/CEP-SPEC.md).

## Creating a New Integration

1. **Create directory**: `integrations/your-agent/`
2. **Implement event capture**: Send events to `POST /api/ingest`
3. **Follow CEP format**: See [CEP-SPEC.md](../backend/CEP-SPEC.md)
4. **Document installation**: Add README.md with setup instructions

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

See [backend adapters](../backend/adapters/README.md) for data format processing.

## Backend Support

The backend already supports multiple runners via adapters in `backend/adapters/`:
- ✅ `claude-code.js` - Claude Code event processor
- ✅ `opencode.js` - OpenCode event processor
- 🔧 Add more as needed for new event formats

## Contributing

See the main [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines on adding new integrations.
