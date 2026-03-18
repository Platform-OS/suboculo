# Agent Actions Monitor - Claude Code Plugin

Real-time monitoring for Claude Code sessions. Captures all tool usage, agent spawns, and session events for analysis, debugging, and workflow optimization.

## What It Does

This plugin automatically captures and logs:

- **Tool Events**: Every tool Claude uses (Bash, Read, Write, Edit, Glob, Grep, etc.)
- **Session Events**: Session start with working directory
- **Timing Data**: Timestamps for all events
- **Status Tracking**: Success/error status for tool executions
- **Full Context**: Tool arguments, outputs, and session correlation

All events are sent to the Agent Actions Viewer backend for real-time visualization and analysis.

## Installation

### Prerequisites

1. **Claude Code** (version 1.0.33 or later)
   ```bash
   claude --version
   ```

2. **jq** (JSON processor)
   ```bash
   # macOS
   brew install jq

   # Debian/Ubuntu
   apt-get install jq

   # Verify installation
   jq --version
   ```

3. **Agent Actions Viewer Backend** running on `http://localhost:3000`
   ```bash
   cd backend && npm start
   ```

### Install the Plugin

#### Option 1: From GitHub (Recommended)

```bash
# Once published to GitHub
/plugin install github:your-org/suboculo/integrations/claude-code
```

#### Option 2: Local Development

```bash
# Clone the repository
git clone https://github.com/your-org/suboculo.git
cd suboculo

# Load the plugin
claude --plugin-dir ./integrations/claude-code
```

## Usage

Once installed, the plugin works automatically:

1. **Start Claude Code** (the plugin loads automatically if installed via marketplace)
   ```bash
   claude
   ```

2. **Use Claude Code normally** - every tool use is automatically captured

3. **View events in the browser**
   ```bash
   open http://localhost:5173
   ```

4. **Filter by session** - each Claude Code session gets a unique ID for easy tracking

## What Gets Captured

### Tool Events

**tool.start** - Before any tool executes:
```json
{
  "event": "tool.start",
  "runner": "claude-code",
  "sessionId": "f7dfbd6d-71fa-4e64-ab77-08dd0faef228",
  "traceId": "toolu_01Y512TCmTK1zkbF6HHPbKim",
  "data": {
    "tool": "Bash",
    "args": {
      "command": "npm test",
      "description": "Run tests"
    }
  }
}
```

**tool.end** - After tool completes:
```json
{
  "event": "tool.end",
  "runner": "claude-code",
  "sessionId": "f7dfbd6d-71fa-4e64-ab77-08dd0faef228",
  "traceId": "toolu_01Y512TCmTK1zkbF6HHPbKim",
  "data": {
    "tool": "Bash",
    "status": "success",
    "result": "All tests passed",
    "outputLen": 17
  }
}
```

### Session Events

**session.start** - When Claude Code session begins:
```json
{
  "event": "session.start",
  "runner": "claude-code",
  "sessionId": "f7dfbd6d-71fa-4e64-ab77-08dd0faef228",
  "data": {
    "directory": "/srv/Projects/my-project"
  }
}
```

## Configuration

### Change Backend URL

By default, events are sent to `http://localhost:3000`. To use a different backend:

1. **Edit the plugin's hooks.json**:
   ```bash
   # Find the plugin installation directory
   # Usually ~/.claude/plugins/agent-actions-monitor/

   # Edit hooks/hooks.json and replace all instances of:
   # http://localhost:3000
   # with your backend URL
   ```

2. **Restart Claude Code** to apply changes

### Disable the Plugin

```bash
# Temporarily disable
/plugin disable agent-actions-monitor

# Re-enable
/plugin enable agent-actions-monitor

# Uninstall completely
/plugin uninstall agent-actions-monitor
```

## Troubleshooting

### Events Not Appearing

**1. Check backend is running:**
```bash
curl http://localhost:3000/api/facets
# Should return JSON with facets
```

**2. Check jq is installed:**
```bash
jq --version
# Should show version number
```

**3. Check plugin is enabled:**
```bash
/plugin list
# Should show agent-actions-monitor as enabled
```

**4. Check hooks are loaded:**
```bash
/hooks
# Should show PreToolUse, PostToolUse, SessionStart hooks
```

**5. Test manually:**
```bash
# Send a test event
curl -X POST http://localhost:3000/api/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "ts": "2026-03-07T12:00:00Z",
    "event": "tool.start",
    "runner": "claude-code",
    "sessionId": "test",
    "data": {"tool": "test"}
  }'

# Check it appears
curl http://localhost:3000/api/entries?sessionID=test
```

### Hook Errors

If you see hook errors in Claude Code output:

```bash
# Run Claude Code with debug output
claude --debug

# Look for hook-related errors
```

Common issues:
- `jq: command not found` - Install jq
- `curl: command not found` - Install curl (usually pre-installed)
- Backend not accessible - Check firewall, backend is running, correct URL

## Privacy & Security

### What Data is Captured

- ✅ Tool names (Bash, Read, Write, etc.)
- ✅ Command arguments and file paths
- ✅ Tool output snippets (stdout/stderr)
- ✅ Session IDs and timestamps

### Where Data is Stored

- **Local only** by default (SQLite database at `backend/actions.db`)
- **No external transmission** unless you configure a remote backend
- **You control the data** - it's your database

### Production Use

For production/team use:

1. **Review captured data** - ensure no sensitive information in tool arguments
2. **Use HTTPS** for remote backends
3. **Add authentication** if exposing backend over network
4. **Configure firewall** appropriately

## Development

### Project Structure

```
plugin/
├── .claude-plugin/
│   └── plugin.json       # Plugin manifest
├── hooks/
│   └── hooks.json        # Hook configurations
└── README.md             # This file
```

### Testing Changes

```bash
# Make changes to hooks/hooks.json

# Reload with --plugin-dir (from repo root)
cd /path/to/suboculo
claude --plugin-dir ./integrations/claude-code

# Test your changes
```

### Contributing

See the main repository for contribution guidelines.

## Links

- **Documentation**: [CLAUDE-CODE-INTEGRATION.md](../backend/CLAUDE-CODE-INTEGRATION.md)
- **CEP Specification**: [CEP-SPEC.md](../backend/CEP-SPEC.md)
- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3000/api
## Support

- **Issues**: https://github.com/your-org/suboculo/issues
- **Discussions**: https://github.com/your-org/suboculo/discussions
