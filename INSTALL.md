# Suboculo Installation Guide

## Quick Install

From the root of the project you want to monitor:

```bash
/path/to/agent-actions-viewer/install-suboculo.sh .
```

Or from this repository:

```bash
./install-suboculo.sh /path/to/target/project
```

## What Gets Installed

```
your-project/
  suboculo-mcp/
    event-writer.mjs           # Captures events from hooks
    mcp-analytics-server.mjs   # MCP server for querying/analyzing
    hooks.json                 # Hook definitions (for reference)
    package.json               # Dependencies
    node_modules/              # Installed automatically
  .mcp.json                    # MCP server configuration (created)
  .gitignore                   # Updated to exclude .suboculo/
```

## Manual Installation

If you prefer to install manually:

### 1. Create directory and copy files

```bash
mkdir -p your-project/suboculo-mcp
cd your-project/suboculo-mcp

# Copy these 4 files:
cp /path/to/agent-actions-viewer/integrations/claude-code/hooks/event-writer.mjs .
cp /path/to/agent-actions-viewer/integrations/claude-code/hooks/package.json .
cp /path/to/agent-actions-viewer/backend/mcp-analytics-server.mjs .

# Install dependencies
npm install
```

### 2. Configure MCP server

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "suboculo": {
      "command": "node",
      "args": ["./suboculo-mcp/mcp-analytics-server.mjs"],
      "env": {
        "SUBOCULO_DB_PATH": ".suboculo/events.db"
      }
    }
  }
}
```

### 3. Configure hooks

Create or edit `.claude/settings.local.json` in your project:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "jq -c '{ts: (now | todate), event: \"tool.end\", runner: \"claude-code\", sessionId: .session_id, traceId: .tool_use_id, data: {tool: .tool_name, args: .tool_input, status: (if .tool_response.interrupted then \"error\" else \"success\" end), result: .tool_response.stdout, outputLen: (.tool_response.stdout | length)}}' | node ./suboculo-mcp/event-writer.mjs",
        "timeout": 5
      }]
    }],
    "PreToolUse": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "jq -c '{ts: (now | todate), event: \"tool.start\", runner: \"claude-code\", sessionId: .session_id, traceId: .tool_use_id, data: {tool: .tool_name, args: .tool_input}}' | node ./suboculo-mcp/event-writer.mjs",
        "timeout": 5
      }]
    }],
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "jq -c -n --arg ts \"$(date -Iseconds)\" --arg sid \"$CLAUDE_SESSION_ID\" --arg dir \"$(pwd)\" '{ts: $ts, event: \"session.start\", runner: \"claude-code\", sessionId: $sid, data: {directory: $dir}}' | node ./suboculo-mcp/event-writer.mjs",
        "timeout": 5
      }]
    }]
  }
}
```

### 4. Add to .gitignore

```bash
echo ".suboculo/" >> .gitignore
```

## Verify Installation

1. Restart Claude Code
2. Run any tool (e.g., `ls`)
3. Check the database was created:
   ```bash
   ls -la .suboculo/events.db
   sqlite3 .suboculo/events.db "SELECT COUNT(*) FROM entries"
   ```
4. Ask Claude to analyze your usage:
   ```
   What tools have I used most?
   ```

## Using Suboculo

### MCP Tools Available

- `suboculo_get_facets` — Discover available data
- `suboculo_get_stats` — Summary statistics
- `suboculo_list_sessions` — Recent sessions
- `suboculo_query_events` — Query with filters (supports `since`/`until`)
- `suboculo_get_session` — Full session timeline

### Example Queries

```
Show me events from the last 30 minutes
```

```
What Bash commands did I run today?
```

```
Analyze my Read vs Edit ratio
```

```
Which tools take the longest?
```

## Web Viewer (Optional)

If you want the visual interface:

```bash
cd /path/to/agent-actions-viewer/backend
SUBOCULO_DB_PATH=/path/to/your/project/.suboculo/events.db node server.js
```

Then in another terminal:

```bash
cd /path/to/agent-actions-viewer/svelte-app
npm run dev
```

Open http://localhost:5173

## Troubleshooting

**No events appearing?**
- Check `.suboculo/events.db` exists
- Verify hooks are in `.claude/settings.local.json`
- Restart Claude Code

**MCP server not connecting?**
- Check `.mcp.json` exists in project root
- Verify `suboculo-mcp/mcp-analytics-server.mjs` exists
- Run `/mcp` in Claude Code to see status

**Native module errors?**
- Run `cd suboculo-mcp && npm rebuild better-sqlite3`
- Make sure Node versions match between shell and Claude Code sandbox

## Uninstallation

```bash
rm -rf suboculo-mcp .suboculo .mcp.json
# Remove hooks from .claude/settings.local.json
# Remove .suboculo/ from .gitignore
```
