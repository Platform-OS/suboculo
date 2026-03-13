# Suboculo

***Agens sub oculo*** - Agent under the eye

Real-time monitoring and analytics platform for AI coding agents.

## Architecture

**Per-Project Installation** - Self-contained monitoring for each project
**Frontend:** Svelte + Vite + Tailwind CSS + shadcn-svelte
**Backend:** Node.js + Express + SQLite (better-sqlite3)
**Integration:** Claude Code hooks + MCP analytics server

## Why Per-Project?

✅ **Isolation** - Each project has its own event database
✅ **Sandboxed environments** - Works in Docker, bubblewrap, etc.
✅ **Context-specific** - Analyze agent behavior in project context
✅ **No cross-contamination** - Events stay within project scope
✅ **Self-contained** - Everything lives in `.suboculo/` directory

## Quick Start

### Installation

From this repository:

```bash
./install-suboculo.sh /path/to/your/project
```

This installs Suboculo into `your-project/.suboculo/` with:
- Event capture hooks (writes to SQLite)
- MCP analytics server (query tools for Claude)
- Web backend + frontend (visual monitoring)
- All dependencies

### Usage

**1. Restart Claude Code** (to load hooks)

**2. Events are captured automatically** as you work

**3. Query via MCP tools:**
```
What tools have I used most?
Show me events from the last hour
Analyze my Read vs Edit ratio
```

**4. Visual monitoring (optional):**
```bash
cd your-project
node .suboculo/backend/server.js
```
Then open http://localhost:3000

## What It Does

Monitor and analyze AI agent activity in real-time:

- ✅ **Automatic event capture** - All tool usage tracked via hooks
- ✅ **Real-time streaming** - SSE updates when web UI is running
- ✅ **Resilient capture** - Events stored even if server is down
- ✅ **MCP analytics** - Query events via natural language
- ✅ **LLM-powered analysis** - Analyze agent behavior patterns
- ✅ **Session tracking** - Correlate events across sessions
- ✅ **Tool diversity** - Bash, Read, Edit, MCP tools, all captured
- ✅ **Duration tracking** - Automatic timing for tool execution

## Features

### Event Capture
- Automatic hooks for Claude Code (PreToolUse, PostToolUse, SessionStart)
- Direct SQLite writes (resilient, works offline)
- Optional SSE notifications (real-time when server running)
- Handles all tool types (different response structures)

### Analysis & Querying
- **MCP tools** for CLI queries via Claude
- **Web UI** for visual filtering and exploration
- **LLM analysis** with custom prompts
- **Duration calculation** for performance insights
- **Session correlation** across multiple agent invocations

### Data Management
- Per-project SQLite database (`.suboculo/events.db`)
- Efficient indexing for fast queries
- Common Event Protocol (CEP) format
- Tag and annotate events (via web UI)

## How It Works

**Event Flow:**
```
Claude executes tool
        ↓
Hook captures event → event-writer.mjs → SQLite (.suboculo/events.db)
                   ↘ (if server running) → POST /api/notify → SSE clients
        ↓
Frontend updates in real-time (or query via MCP)
```

**Dual-Write Architecture:**
1. **Primary:** Direct write to SQLite (always works)
2. **Secondary:** HTTP POST to `/api/notify` (triggers SSE if server running)

This ensures events are never lost while enabling real-time updates when monitoring.

## Installation Details

When you run `install-suboculo.sh`, it creates:

```
your-project/
  .suboculo/
    integrations/claude-code/
      event-writer.mjs       # Captures events to DB
    backend/
      server.js              # Web server (API + static files)
      cep-processor.js       # Event validation
      mcp-analytics-server.mjs  # MCP query server
    frontend/                # Built web UI
    package.json
    node_modules/
    events.db               # SQLite database (created on first event)
  .claude/
    settings.local.json     # Hooks configuration
  .mcp.json                 # MCP server configuration
```

See [INSTALL.md](./INSTALL.md) for detailed installation instructions and troubleshooting.

## Use Cases

**Visual filtering + scoped analysis:**
1. Browse events in web UI
2. Filter to interesting subset (e.g., errors, specific tools)
3. Go back to Claude CLI with specific scope for analysis
4. Save tokens by pre-filtering visually

**Session analysis:**
```
What did I do in this session?
Show me the timeline for session abc123
Compare my tool usage today vs yesterday
```

**Performance monitoring:**
```
Which tools are slowest?
Show me events that took > 5 seconds
Analyze my workflow efficiency
```

## Project Structure (This Repository)

```
agent-actions-viewer/
├── backend/                    # Backend components
│   ├── server.js              # Express server (API + static serving)
│   ├── cep-processor.js       # CEP event validation
│   └── mcp-analytics-server.mjs  # MCP server for queries
├── svelte-app/                # Frontend
│   ├── src/
│   └── dist/                  # Built files (copied on install)
├── integrations/claude-code/  # Claude Code integration
│   └── hooks/
│       ├── event-writer.mjs   # Direct SQLite writer
│       ├── hooks.json         # Hook definitions (source)
│       └── package.json       # Dependencies
├── install-suboculo.sh        # Installation script
├── INSTALL.md                 # Installation guide
└── README.md                  # This file
```

## Development

### Working on Suboculo itself

**Backend:**
```bash
cd backend
npm install
SUBOCULO_DB_PATH=./events.db node server.js
```

**Frontend:**
```bash
cd svelte-app
npm install
npm run dev  # http://localhost:5173
```

**Build frontend for installation:**
```bash
cd svelte-app
npm run build  # Creates dist/ directory
```

### Testing in a project

```bash
# Install in test project
./install-suboculo.sh /path/to/test/project

# Restart Claude Code in that project
cd /path/to/test/project
claude  # (with Suboculo hooks loaded)
```

## Security

Suboculo is **local-first** by default.

### Per-Project Setup (Default)
- Events stored in project's `.suboculo/events.db`
- Backend runs on `localhost:3000` (per project)
- MCP server communicates via stdio (local)
- No network exposure unless you expose the port
- Data never leaves your machine

### What Gets Stored
- **Event data:** tool names, arguments, outputs, session IDs
- **Timing:** timestamps, durations
- **Context:** working directory, session metadata
- **Analysis:** LLM analysis results (if you run analysis)

All data stays in `.suboculo/events.db`. Add `.suboculo/` to `.gitignore` (done automatically by install script).

### Network Deployment (Optional)
If exposing on a network:
1. Use HTTPS (TLS termination via reverse proxy)
2. Add authentication (not built-in yet)
3. Restrict CORS in server.js
4. Consider data sensitivity (command outputs may contain secrets)

## Sandboxed Environments

Suboculo works in isolated environments:

- ✅ **Docker containers** - Full stack per container
- ✅ **Bubblewrap** - Filesystem isolation supported
- ✅ **Per-user sandboxes** - Each user gets their own instance

The per-project architecture means each sandbox gets its own complete Suboculo installation without sharing state.

## Troubleshooting

### No events appearing
```bash
# Check database exists
ls -la .suboculo/events.db

# Check hooks are installed
cat .claude/settings.local.json | jq '.hooks'

# Restart Claude Code
```

### Real-time updates not working
```bash
# Check backend is running
lsof -ti:3000

# Check SSE connection in browser console (should see "SSE connection opened")

# If curl errors in hooks, server may be down - events still captured to DB
```

### MCP tools not available
```bash
# Check MCP configuration
cat .mcp.json

# Check MCP server file exists
ls -la .suboculo/backend/mcp-analytics-server.mjs

# Run /mcp command in Claude Code to see server status
```

### Native module errors
```bash
# Rebuild better-sqlite3 for your Node version
cd .suboculo
npm rebuild better-sqlite3
```

See [INSTALL.md](./INSTALL.md) for detailed troubleshooting.

## License

MIT

---

**Note:** This is v0.1 - per-project architecture. The original centralized design (all projects → one backend) is deprecated in favor of project-specific isolation, especially for sandboxed environments.
