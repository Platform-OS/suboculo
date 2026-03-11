# Claude Code Integration Guide

## Overview

Integrate Claude Code with the suboculo for real-time monitoring of your AI coding sessions.

**Updated:** March 2026 - Reflects actual Claude Code hooks system

---

## 🚀 Recommended: Use the Plugin

The easiest way to get started is with the **Claude Code plugin**:

```bash
# Install the plugin (once published)
/plugin install github:your-org/suboculo/plugin

# Or test locally
claude --plugin-dir ./plugin
```

See [plugin/README.md](../plugin/README.md) for full plugin documentation.

**Continue below for manual installation** if you prefer not to use plugins.

---

---

## Quick Start (30 seconds)

```bash
# 1. Install hooks to Claude Code settings
# Copy the hooks configuration to your settings.json
# If ~/.claude/settings.json exists, merge the "hooks" section
# Otherwise, create it with the hooks configuration
cp backend/hooks/hooks.json ~/.claude/settings.json

# 2. Start backend (if not running)
cd backend && npm start

# 3. Start frontend (if not running)
cd svelte-app && npm run dev

# 4. Restart Claude Code to load hooks
claude

# 5. View in browser
open http://localhost:5173
```

**That's it!** Your Claude Code sessions are now being monitored.

---

## How It Works

### Architecture

```
Claude Code Session
    ↓
~/.claude/settings.json (hooks configuration)
    ↓
Hook Triggers (PreToolUse, PostToolUse, SessionStart)
    ↓
jq → Transform to CEP format
    ↓
curl POST → http://localhost:3000/api/ingest
    ↓
SQLite Database (CEP format)
    ↓
Frontend Viewer (http://localhost:5173)
```

### What Gets Captured

**Tool Events:**
- `tool.start` - When any tool begins (Read, Write, Edit, Bash, etc.)
- `tool.end` - When tool completes (with status: success/error, duration)

**Session Events:**
- `session.start` - When Claude Code session begins

**Data Captured:**
- Tool name (Read, Write, Bash, etc.)
- Arguments (file paths, commands, etc.)
- Results (truncated for large outputs)
- Duration (milliseconds)
- Status (success/error)
- Session ID (for correlation)
- Trace ID (for pairing tool.start with tool.end)

---

## Installation Details

### Prerequisites

- Claude Code installed (`claude` command available)
- Backend server running on http://localhost:3000
- `jq` installed (`brew install jq` or `apt-get install jq`)

### Installation

**Important:** Hooks must be configured in `~/.claude/settings.json` (NOT a separate hooks.json file).

**Method 1: New settings.json (if you don't have one)**

```bash
# Copy template as your settings.json
cp backend/hooks/hooks.json ~/.claude/settings.json
```

**Method 2: Merge with existing settings.json**

If you already have `~/.claude/settings.json`, add the `"hooks"` section from `backend/hooks/hooks.json` to your existing settings:

```bash
# Backup your current settings
cp ~/.claude/settings.json ~/.claude/settings.json.backup

# Edit settings.json and add the "hooks" section from backend/hooks/hooks.json
# Your settings.json should look like:
# {
#   "hooks": { ... hooks from template ... },
#   ... your other settings ...
# }
```

### Verify Installation

```bash
# Check hooks are configured
cat ~/.claude/settings.json | jq .hooks

# Or use the interactive menu in Claude Code
claude
# Then type: /hooks
# You should see PreToolUse, PostToolUse, and SessionStart hooks listed
```

---

## Configuration

### Backend URL

**Default:** `http://localhost:3000`

**To change:**

Edit `~/.claude/hooks.json` (or `backend/hooks/hooks.json` if symlinked):

```bash
# Replace all instances of localhost:3000
sed -i 's|localhost:3000|your-server:3000|g' ~/.claude/hooks.json
```

Or for remote server:

```bash
sed -i 's|localhost:3000|192.168.1.100:3000|g' ~/.claude/hooks.json
```

### Environment Variables

Hooks use standard environment variables:

- `$CLAUDE_SESSION_ID` - Current session ID
- `$(pwd)` - Working directory
- `$(date -Iseconds)` - Current timestamp

---

## Usage

### Normal Usage

Just use Claude Code as normal:

```bash
claude

# Any tool use is automatically captured:
> Read the README file
> Run npm test
> Edit src/main.js and add a comment
```

**Events appear in the viewer immediately!**

### Viewing Events

**Frontend:**
```bash
open http://localhost:5173
# Select "claude-code" from Runner filter
```

**API:**
```bash
# View all Claude Code events
curl http://localhost:3000/api/entries?runner=claude-code

# View specific session
curl http://localhost:3000/api/entries?sessionID=your-session-id

# View facets
curl http://localhost:3000/api/facets
```

---

## Testing

### Test End-to-End

**1. Start services:**
```bash
# Terminal 1 - Backend
cd backend && npm start

# Terminal 2 - Frontend
cd svelte-app && npm run dev
```

**2. Use Claude Code:**
```bash
# Terminal 3
claude

# Try a simple tool use:
> Read ~/.claude/hooks.json
```

**3. Check viewer:**
```bash
open http://localhost:5173
# Select "claude-code" runner
# You should see:
#   - tool.start (Read)
#   - tool.end (Read) with ✓ success
```

### Test Manual Event

Send a test event directly:

```bash
curl -X POST http://localhost:3000/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "ts": "'$(date -Iseconds)'",
    "event": "tool.start",
    "runner": "claude-code",
    "sessionId": "test_session",
    "data": {
      "tool": "test",
      "args": {}
    }
  }'

# Check it appears in viewer
```

---

## Troubleshooting

### Events Not Appearing

**1. Check backend is running:**
```bash
curl http://localhost:3000/api/facets
# Should return JSON
```

**2. Check hooks are installed:**
```bash
cat ~/.claude/hooks.json
# Should show hook configuration
```

**3. Check jq is installed:**
```bash
jq --version
# Should show version
```

**4. Test hook manually:**
```bash
# Simulate a tool event
echo '{
  "tool_name": "Read",
  "tool_input": {"file_path": "/tmp/test.txt"},
  "session_id": "test_123",
  "tool_call_id": "call_123",
  "timestamp": "'$(date -Iseconds)'"
}' | jq -c '{
  ts: .timestamp,
  event: "tool.start",
  runner: "claude-code",
  sessionId: .session_id,
  traceId: .tool_call_id,
  data: {tool: .tool_name, args: .tool_input}
}' | curl -s -X POST -H "Content-Type: application/json" \
  -d @- http://localhost:3000/api/ingest

# Check if event appears
curl http://localhost:3000/api/entries?sessionID=test_123
```

**5. Check Claude Code debug logs:**
```bash
claude --debug hooks

# Look for hook execution messages
```

### Hook Errors

**Syntax errors in hooks.json:**
```bash
jq . ~/.claude/hooks.json
# Should pretty-print JSON without errors
```

**curl not working:**
```bash
# Test curl directly
curl -X POST http://localhost:3000/api/facets
```

**Backend not accessible:**
```bash
# Check port
nc -zv localhost 3000

# Check firewall
sudo ufw status
```

### Performance Issues

**Hooks too slow?**

The hooks have 5-second timeouts. If they're slowing down Claude Code:

1. **Reduce timeout** in hooks.json: `"timeout": 2`
2. **Run backend locally** (not over network)
3. **Disable specific hooks** temporarily

**Disable a hook:**
```json
{
  "PostToolUse": [],  // Disabled
  "PreToolUse": [...]  // Still active
}
```

---

## Advanced

### Capture Additional Events

Add more hook events to `hooks.json`:

**SessionEnd:**
```json
{
  "SessionEnd": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "bash -c 'jq -c -n --arg ts \"$(date -Iseconds)\" \"{ts: \\$ts, event: \\\"session.end\\\", runner: \\\"claude-code\\\", sessionId: \\\"$CLAUDE_SESSION_ID\\\", data: {reason: \\\"completed\\\"}}\" | curl -s -X POST -H \"Content-Type: application/json\" -d @- http://localhost:3000/api/ingest'",
          "timeout": 5
        }
      ]
    }
  ]
}
```

### Filter Specific Tools

Only capture Write/Edit/Bash:

```json
{
  "PostToolUse": [
    {
      "matcher": "Write|Edit|Bash",
      "hooks": [...]
    }
  ]
}
```

### Custom Transformations

Modify the jq transform to capture different fields:

```bash
# Current transform
jq -c '{ts: .timestamp, event: "tool.end", ...}'

# Add custom field
jq -c '{ts: .timestamp, event: "tool.end", custom_field: "value", ...}'
```

---

## Comparison: What We Tried

### ❌ Approach 1: Standalone shell scripts (Didn't Work)

```bash
mkdir -p ~/.claude/hooks
cp hooks/claude-code-hook.js ~/.claude/hooks/
chmod +x ~/.claude/hooks/claude-code-hook.js
```

**Why it didn't work:** Claude Code doesn't execute standalone shell scripts in ~/.claude/hooks/

### ❌ Approach 2: Separate hooks.json file (Didn't Work)

```bash
cp backend/hooks/hooks.json ~/.claude/hooks.json
```

**Why it didn't work:** Hooks must be in settings.json, not a separate hooks.json file

### ✅ Correct Approach (Works!)

```bash
# Add hooks to settings.json
cp backend/hooks/hooks.json ~/.claude/settings.json
# (or merge the "hooks" section if you have existing settings)
```

**Why it works:**
- Uses Claude Code's actual hooks system
- Correct location (`~/.claude/settings.json`)
- Correct format (hooks inside settings.json)
- Hooks are triggered automatically by Claude Code
- Uses correct JSON field names (tool_use_id, tool_response, etc.)

---

## Files Reference

| File | Purpose | Status |
|------|---------|--------|
| `plugin/` | ✅ **RECOMMENDED** - Claude Code plugin | ACTIVE |
| `backend/hooks/hooks.json` | ✅ Hook configuration template (manual install) | ACTIVE |
| `~/.claude/settings.json` | ✅ Your Claude Code settings (for manual install) | ACTIVE |
| `backend/hooks/README.md` | Manual installation documentation | Reference |

**Recommended:** Use the [Claude Code plugin](../plugin/) for easiest installation. Manual installation via settings.json is also supported.

---

## Security Considerations

### Data Privacy

Hooks capture:
- ✅ Tool names (Read, Write, Bash)
- ✅ File paths
- ✅ Command arguments
- ✅ Output snippets (truncated)

**Sensitive data?**
- Events stored locally in SQLite
- No external transmission (unless you configure it)
- Review captured data in the viewer

### Network

**Default:** `http://localhost:3000` (local only)

**For remote backend:**
- Use HTTPS in production
- Add authentication if needed
- Firewall appropriately

---

## Uninstallation

```bash
# Remove hooks
rm ~/.claude/hooks.json

# Events will stop being captured immediately
# No restart needed
```

**To reinstall:** Just copy hooks.json again.

---

## See Also

- `hooks/README.md` - Hook installation guide
- `CEP-SPEC.md` - Event format specification
- `INGESTION.md` - API documentation
- `FRONTEND-CEP.md` - Frontend features

---

## Support

**Events not showing up?**
1. Check all steps in "Troubleshooting" section
2. Test with manual event injection
3. Check Claude Code debug logs: `claude --debug hooks`
4. Verify backend is accessible: `curl http://localhost:3000/api/facets`

**Questions about hooks.json format?**
- See Claude Code plugin documentation: `~/.claude/plugins/.../plugin-dev/skills/hook-development/`
