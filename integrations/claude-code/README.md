# Claude Code Integration

Claude Code integration for Suboculo.

This integration uses Claude hooks plus a standalone `event-writer.mjs` copied into the target project. It is not a marketplace/plugin package and it does not depend on a central shared backend process to capture events.

## Installation

Use the canonical installer from the repository root:

```bash
./install-suboculo.sh /path/to/project
```

For full install instructions, see [INSTALL.md](../../INSTALL.md).

## Installed Layout

After installation, the target project contains:

```text
your-project/
  .suboculo/
    integrations/claude-code/
      event-writer.mjs
    backend/
      server.js
      cep-processor.js
      logger.js
      mcp-analytics-server.mjs
    frontend/
    events.db
  .claude/
    settings.local.json
  .mcp.json
```

## How It Works

Claude hook events are transformed to CEP and written directly to `.suboculo/events.db` by `event-writer.mjs`.

Realtime UI updates are optional:

- direct SQLite write is the primary path
- `POST /api/notify` is a secondary path used only when the Suboculo server is running

This means capture continues even when the web server is down.

## What It Captures

- `session.start`
- `tool.start`
- `tool.end`
- `subagent.spawn`
- `subagent.stop`
- `usage`

Claude-specific enrichment includes:

- agent and subagent attribution
- transcript-derived inner tool calls for `Task` subagents
- token usage extraction from transcript entries
- status tracking
- duration tracking with provenance (`durationSource`)

## Timing Semantics

Claude Code tool durations in Suboculo are usually derived from hook-observed `tool.start` and `tool.end` timestamps.

That means the recorded duration is typically:

- harness-observed wall-clock time
- not guaranteed to be the tool's internal execution time
- sensitive to hook timing and runner-side overhead

Suboculo records timing provenance in `data.durationSource`:

- `reported_by_runner`: the runner supplied a duration directly
- `derived_hook_timestamps`: Suboculo derived duration from hook timestamps

For Claude Code, `derived_hook_timestamps` is the expected case today.

## Notes

- The UI is served by `node .suboculo/backend/server.js`, not by a separate frontend dev server in normal use.
- The browser URL is the configured Suboculo port, typically `http://localhost:3000`.
- Port changes are handled by re-running the installer with `--port`.
- OpenCode duration measurements are generally stronger because they are captured in-process by the plugin runtime rather than inferred from external hooks.

## Troubleshooting

- check `.suboculo/events.db` exists after Claude uses a tool
- inspect `.claude/settings.local.json` to confirm Suboculo hooks were merged
- if realtime updates are missing, verify the backend is running on the configured port
- if events are captured but the UI is empty, query the DB directly:

```bash
sqlite3 .suboculo/events.db "SELECT runner, event, COUNT(*) FROM entries GROUP BY runner, event ORDER BY runner, event;"
```

## References

- [INSTALL.md](../../INSTALL.md)
- [README.md](../../README.md)
- [CEP-SPEC.md](../../backend/CEP-SPEC.md)
