# Suboculo Installation Guide

## Quick Install

### For Claude Code

From this repository:

```bash
./install-suboculo.sh /path/to/target/project
```

Or from within the project you want to monitor:

```bash
/path/to/agent-actions-viewer/install-suboculo.sh .
```

### For OpenCode

From this repository:

```bash
./install-suboculo-opencode.sh /path/to/target/project
```

Or from within the project you want to monitor:

```bash
/path/to/agent-actions-viewer/install-suboculo-opencode.sh .
```

### Both in Same Project

You can install both integrations in the same project to monitor both Claude Code and OpenCode. They will share the same `.suboculo/events.db` database:

```bash
./install-suboculo.sh /path/to/project
./install-suboculo-opencode.sh /path/to/project
```

### Custom Port

To run multiple Suboculo instances (one per project), assign each a unique port:

```bash
./install-suboculo.sh /path/to/project-a --port 3000
./install-suboculo-opencode.sh /path/to/project-b --port 3001
```

The port is baked into hooks/MCP config at install time. Default is 3000.

## What Gets Installed

### Claude Code Installation

```
your-project/
  .suboculo/
    integrations/claude-code/
      event-writer.mjs           # Captures events to SQLite
    backend/
      server.js                  # Web server (API + static files)
      cep-processor.js           # Event validation
      logger.js                  # Shared logging helper
      mcp-analytics-server.mjs   # MCP server for querying/analyzing
    frontend/                    # Built web UI
    package.json                 # Dependencies
    node_modules/                # Installed automatically
    events.db                    # SQLite database (created on first event)
  .claude/
    settings.local.json          # Hooks configuration (created/merged)
  .mcp.json                      # MCP server configuration (created/merged)
```

The install script merges into existing `.claude/settings.local.json` and `.mcp.json` files if they exist, preserving your other settings.

### OpenCode Installation

```
your-project/
  .suboculo/
    backend/
      server.js                  # Web server (API + static files)
      cep-processor.js           # Event validation
      logger.js                  # Shared logging helper
      mcp-analytics-server.mjs   # MCP server for querying/analyzing
    frontend/                    # Built web UI
    package.json                 # Backend dependencies
    node_modules/                # Installed automatically
    events.db                    # SQLite database (created on first event)
  .opencode/
    plugins/
      suboculo.js                # Event capture plugin
  opencode.json                  # MCP server configuration (created/merged)
```

The install script merges into existing `opencode.json` if it exists. OpenCode automatically loads plugins from `.opencode/plugins/` directory.

## Verify Installation

### Claude Code

1. Restart Claude Code
2. Run any tool (e.g., read a file)
3. Check the database was created:
   ```bash
   ls -la .suboculo/events.db
   sqlite3 .suboculo/events.db "SELECT COUNT(*) FROM entries"
   ```
4. Ask Claude to analyze your usage:
   ```
   What tools have I used most?
   ```

### OpenCode

1. Restart OpenCode
2. Run any tool (e.g., read a file)
3. Check the database was created:
   ```bash
   ls -la .suboculo/events.db
   sqlite3 .suboculo/events.db "SELECT COUNT(*) FROM entries WHERE runner='opencode'"
   ```
4. Check plugin is loaded:
   ```bash
   ls -la .opencode/plugins/suboculo.js
   ```
5. Query via MCP (if configured):
   ```
   What tools have I used most?
   ```

## Using Suboculo

### MCP Tools Available

| Tool | Description |
|------|-------------|
| `suboculo_get_facets` | Discover available runners, event types, tools, sessions |
| `suboculo_get_stats` | Summary statistics (totals, top tools, durations) |
| `suboculo_list_sessions` | Recent sessions with event counts |
| `suboculo_query_events` | Query with filters, pagination, time ranges |
| `suboculo_get_session` | Full chronological timeline for a session |
| `suboculo_get_selection` | Get events selected in web UI ("Send to CLI") |
| `suboculo_save_analysis` | Save analysis to web UI Analyses tab |

### Example Queries

```
Show me events from the last 30 minutes
What Bash commands did I run today?
Analyze my Read vs Edit ratio
Which tools take the longest?
What did the Explore subagents do?
```

### Web UI

Start the web server:

```bash
cd your-project
node .suboculo/backend/server.js
```

Open http://localhost:3000 (port is set during installation).

Features:
- Real-time event streaming (SSE)
- Filter by tool, event type, session, runner, agent type
- Filter by attempt (derived task-run segment)
- Agent/subagent tracking (see which agent executed each tool)
- Task Runs tab with attempt-level runs
- Structured outcome recording and summary analytics
- Select events and send to CLI for analysis
- Analyses tab for viewing saved analyses
- Tag and annotate events

### CLI-to-UI Analysis Bridge

1. Open web UI, browse and filter events
2. Select interesting events using checkboxes
3. Click "Send to CLI"
4. In Claude Code: "Analyze my selected events"
5. Ask Claude to save the analysis — it appears in the web UI Analyses tab

## Manual Installation

If you prefer to install manually:

### 1. Create directory and copy files

```bash
mkdir -p your-project/.suboculo/{integrations/claude-code,backend,frontend}

# Copy backend
cp backend/server.js backend/cep-processor.js backend/logger.js backend/mcp-analytics-server.mjs your-project/.suboculo/backend/

# Copy event writer
cp integrations/claude-code/hooks/event-writer.mjs your-project/.suboculo/integrations/claude-code/

# Copy frontend (build first: cd svelte-app && npm run build)
cp -r svelte-app/dist/* your-project/.suboculo/frontend/

# Copy package.json and install dependencies
cp integrations/claude-code/hooks/package.json your-project/.suboculo/
cd your-project/.suboculo && npm install
```

### 2. Configure MCP server

Create or merge into `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "suboculo": {
      "command": "node",
      "args": ["./.suboculo/backend/mcp-analytics-server.mjs"],
      "env": {
        "SUBOCULO_DB_PATH": ".suboculo/events.db",
        "SUBOCULO_PORT": "3000"
      }
    }
  }
}
```

### 3. Configure hooks

Create or merge into `.claude/settings.local.json`:

```bash
# Easiest: extract from the source hooks.json
# Replace 3000 with your port if using a custom port
jq -n --argjson hooks "$(jq '.hooks' /path/to/agent-actions-viewer/integrations/claude-code/hooks/hooks.json)" \
  '{hooks: $hooks}' > .claude/settings.local.json
```

### 4. Add to .gitignore

```bash
echo ".suboculo/" >> .gitignore
```

## Changing the Port

To change the port after installation, re-run the install script with the new port:

```bash
./install-suboculo.sh /path/to/project --port 3001
```

This updates hooks and MCP config with the new port. Restart Claude Code afterward.

## Troubleshooting

**No events appearing?**
- Check `.suboculo/events.db` exists after running a tool
- Verify hooks are in `.claude/settings.local.json`: `cat .claude/settings.local.json | jq '.hooks'`
- Restart Claude Code after installation

**Task Runs look stale or legacy rows dominate?**
- Click "Derive from events" in Task Runs tab
- Optional cleanup of legacy root-session task runs:
  ```bash
  cd .suboculo/backend
  npm run cleanup:legacy-runs
  ```

**Real-time updates not working?**
- Check backend is running: `lsof -ti:3000` (replace with your port)
- Check hooks are curling the correct port: `grep localhost .claude/settings.local.json`
- Check SSE connection in browser console (should see "SSE connection opened")
- Events are still captured to DB even if the server is down

**MCP tools not available?**
- Check `.mcp.json` exists in project root
- Verify MCP server file exists: `ls .suboculo/backend/mcp-analytics-server.mjs`
- Run `/mcp` in Claude Code to see server status

**Native module errors?**
- Rebuild better-sqlite3: `cd .suboculo && npm rebuild better-sqlite3`
- Ensure Node versions match between your shell and Claude Code sandbox

**Port already in use?**
- Check what's using the port: `lsof -ti:3000`
- Use a different port: re-run install with `--port 3001`

## Uninstallation

```bash
rm -rf .suboculo
# Remove suboculo hooks from .claude/settings.local.json
# Remove suboculo entry from .mcp.json
# Remove .suboculo/ from .gitignore
```
