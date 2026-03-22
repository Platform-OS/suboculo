# Suboculo

***Agens sub oculo*** - Agent under the eye

Real-time monitoring and analytics platform for AI coding agents.

## Architecture

**Per-Project Installation** - Self-contained monitoring for each project
**Frontend:** Svelte + Vite + Tailwind CSS + shadcn-svelte
**Backend:** Node.js + Express + SQLite (better-sqlite3)
**Integration:** Claude Code hooks + OpenCode plugins + MCP analytics server

## Why Per-Project?

✅ **Isolation** - Each project has its own event database
✅ **Sandboxed environments** - Works in Docker, bubblewrap, etc.
✅ **Context-specific** - Analyze agent behavior in project context
✅ **No cross-contamination** - Events stay within project scope
✅ **Self-contained** - Everything lives in `.suboculo/` directory

## Quick Start

### Installation for Claude Code

From this repository:

```bash
./install-suboculo.sh /path/to/your/project
```

Custom port (for multiple instances):
```bash
./install-suboculo.sh /path/to/your/project --port 3001
```

This installs Suboculo into `your-project/.suboculo/` with:
- Event capture hooks (writes to SQLite)
- MCP analytics server (query tools for Claude)
- Web backend + frontend (visual monitoring)
- All dependencies

### Installation for OpenCode

From this repository:

```bash
./install-suboculo-opencode.sh /path/to/your/project
```

Custom port (for multiple instances):
```bash
./install-suboculo-opencode.sh /path/to/your/project --port 3001
```

This installs Suboculo into:
- `your-project/.suboculo/` - Shared backend, database, and web UI
- `your-project/.opencode/plugins/` - OpenCode event capture plugin
- All dependencies for both OpenCode plugin and backend

### Usage (Claude Code)

**1. Restart Claude Code** (to load hooks)

**2. Events are captured automatically** as you work

**3. Query via MCP tools:**
```
What tools have I used most?
Show me events from the last hour
Analyze my Read vs Edit ratio
Show reliability KPIs for source=derived_attempt
Compare reliability KPIs for the last 7 days vs previous 7 days
Show reliability trends for the last 30 days, bucketed by week
Show failure mode trends for runner=claude-code
Generate a reliability review for runner=claude-code, week_of=2026-03-16
Generate an after-action report for task run 42
```

**4. Visual monitoring (optional):**
```bash
cd your-project
node .suboculo/backend/server.js
```
Then open http://localhost:3000 (port is set during installation)

### Usage (OpenCode)

**1. Restart OpenCode** (to load plugin)

**2. Events are captured automatically** as you work
   - Plugin captures tool execution, session lifecycle, and permission requests
   - Events written to `.suboculo/events.db` (same database as Claude Code)

**3. Query via MCP tools:**
```
What tools have I used most?
Show me events from the last hour
Compare OpenCode vs Claude Code tool usage
Show reliability KPIs for runner=opencode and source=derived_attempt
Compare reliability KPIs for runner=opencode over the last 14 days vs previous 14 days
Show reliability trends for runner=opencode over the last 30 days
Show failure mode trends for runner=opencode by week
Generate a reliability review for runner=opencode, week_of=2026-03-16
Generate an after-action report for task run 42
```

**4. Visual monitoring (optional):**
```bash
cd your-project
node .suboculo/backend/server.js
```
Then open http://localhost:3000 (port is set during installation)

**Multi-Runner Analysis:** The shared database enables comparing behavior across different AI coding agents (Claude Code and OpenCode) using the same CEP event format with `runner` field differentiation.

### KPI Thresholds Configuration

Suboculo can load KPI targets from a local file:

```bash
cp .suboculo/thresholds.example.json your-project/.suboculo/thresholds.json
```

Example:
```json
{
  "success_rate": { "min": 0.85, "severity": "high" },
  "retry_rate": { "max": 0.2, "severity": "medium" }
}
```

Override precedence:
- built-in defaults in backend
- `.suboculo/thresholds.json` (or `SUBOCULO_THRESHOLDS_PATH`)

### MCP Reliability Workflows

Use these as repeatable analyst playbooks in Claude Code/OpenCode:

1. **Weekly triage (single runner)**
```
Show reliability KPIs for runner=claude-code and source=derived_attempt
Show reliability trends for runner=claude-code, bucket=week, window_days=60
Show failure mode trends for runner=claude-code, bucket=week, window_days=60
```

2. **Runner comparison (same project)**
```
Show reliability KPIs for source=derived_attempt
Show reliability trends for runner=claude-code, bucket=week, window_days=30
Show reliability trends for runner=opencode, bucket=week, window_days=30
```

3. **Postmortem on one failed attempt**
```
List task runs with canonical_outcome_label=failure for runner=opencode
Generate an after-action report for task run <id>
Record a corrected canonical outcome if needed
```

## What It Does

Monitor and analyze AI agent activity in real-time:

- ✅ **Automatic event capture** - All tool usage tracked via hooks
- ✅ **Real-time streaming** - SSE updates when web UI is running
- ✅ **Resilient capture** - Events stored even if server is down
- ✅ **MCP analytics** - Query events via natural language
- ✅ **LLM-powered analysis** - Analyze agent behavior patterns
- ✅ **CLI-to-UI bridge** - Select events in web UI, analyze in CLI, view results in UI
- ✅ **Agent/subagent tracking** - See which agent (lead, Explore, Plan, etc.) executed each tool
- ✅ **Session tracking** - Correlate events across sessions
- ✅ **Tool diversity** - Bash, Read, Edit, MCP tools, all captured
- ✅ **Duration tracking** - Automatic timing for tool execution
- ✅ **Multi-instance support** - Run on custom ports for multiple projects

## Features

### Event Capture
- **Claude Code:** Automatic hooks (PreToolUse, PostToolUse, PostToolUseFailure, SessionStart)
- **OpenCode:** Event-driven plugin (tool.execute.before/after, session.created/deleted, etc.)
- Agent/subagent identification (agent type and ID for each tool call)
- Direct SQLite writes (resilient, works offline)
- Optional SSE notifications (real-time when server running)
- Handles all tool types (different response structures)
- Error capture with status and interrupt detection
- Multi-runner support (Claude Code and OpenCode share same database)

### Analysis & Querying
- **MCP tools** for CLI queries via Claude (14 tools, including reliability KPIs/trends/review/AAR)
- **Web UI** for visual filtering and exploration
- **LLM analysis** with custom prompts (API or CLI)
- **CLI bridge** - Select in UI, analyze in Claude Code, save back to UI
- **Duration calculation** for performance insights
- **Session correlation** across multiple agent invocations
- **Attempt-based task runs** (derived from session boundaries and inactivity gaps)
- **Events filter by attempt** in the web UI
- **KPI Compare polish** (preset windows + custom A/B date ranges)
- **Period-aware compare summaries** (explicit date ranges and per-period run counts)
- **Compare sample guardrails** (canonical sample and known-cost success sufficiency)
- **Shareable compare links** (URL-pinned compare/filter state opening directly on Task Runs)

### Data Management
- Per-project SQLite database (`.suboculo/events.db`)
- Efficient indexing for fast queries
- Common Event Protocol (CEP) format
- Tag and annotate events (via web UI)

## How It Works

**Event Flow (Claude Code):**
```
Claude (lead or subagent) executes tool
        ↓
Hook captures event (tool, args, agent type/id)
        ↓
event-writer.mjs → SQLite (.suboculo/events.db)
  ↘ (if server running) → POST /api/notify → SSE → frontend
```

**Event Flow (OpenCode):**
```
OpenCode executes tool
        ↓
Plugin hook fires (tool.execute.before/after)
        ↓
suboculo.js plugin
  ├─> SQLite (.suboculo/events.db)  [always works]
  └─> POST /api/notify → SSE       [if server running]
```

**Dual-Write Architecture (both runners):**
1. **Primary:** Direct write to SQLite (always works)
2. **Secondary:** HTTP POST to `/api/notify` (triggers SSE if server running)

This ensures events are never lost while enabling real-time updates when monitoring.

## Task Runs: Attempt Semantics

Task runs are derived as **attempts**, not one forever row per root session.

- New attempt starts at `session.start`
- New attempt starts after `session.end` when more events arrive
- New attempt starts after inactivity gap (`45 minutes`)
- Otherwise events stay in the same attempt

Attempt keys use this format:

`root:<rootSessionId>::attempt:<n>`

## Installation Details

### Claude Code Installation

When you run `install-suboculo.sh`, it creates:

```
your-project/
  .suboculo/
    integrations/claude-code/
      event-writer.mjs       # Captures events to DB
    backend/
      server.js              # Web server (API + static files)
      cep-processor.js       # Event validation
      logger.js              # Shared logging helper
      mcp-analytics-server.mjs  # MCP query server
    frontend/                # Built web UI
    package.json
    node_modules/
    events.db               # SQLite database (created on first event)
  .claude/
    settings.local.json     # Hooks configuration
  .mcp.json                 # MCP server configuration
```

### OpenCode Installation

When you run `install-suboculo-opencode.sh`, it creates:

```
your-project/
  .suboculo/
    backend/
      server.js              # Web server (API + static files)
      cep-processor.js       # Event validation
      logger.js              # Shared logging helper
      mcp-analytics-server.mjs  # MCP query server
    frontend/                # Built web UI
    package.json
    node_modules/
    events.db               # SQLite database (created on first event)
  .opencode/
    plugins/
      suboculo.js           # OpenCode event capture plugin
  opencode.json             # OpenCode configuration (MCP server)
```

**Note:** Both installations can coexist in the same project, sharing the `.suboculo/events.db` database for unified monitoring across both AI coding agents. Claude Code uses `.mcp.json` while OpenCode uses `opencode.json`.

See [INSTALL.md](./INSTALL.md) for detailed installation instructions and troubleshooting.

## Use Cases

**Visual filtering + scoped analysis:**
1. Browse events in web UI
2. Filter to interesting subset (e.g., errors, specific tools)
3. Select events and click "Send to CLI"
4. In Claude Code: "Analyze my selected events"
5. Tell Claude to save the analysis — it appears in the web UI Analyses tab

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

**Agent/subagent analysis:**
```
What did the Explore subagents do?
How many tools did each agent type use?
Show me the lead agent vs subagent activity
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
├── integrations/
│   ├── claude-code/           # Claude Code integration
│   │   └── hooks/
│   │       ├── event-writer.mjs   # Direct SQLite writer
│   │       ├── hooks.json         # Hook definitions (source)
│   │       └── package.json       # Dependencies
│   └── opencode/              # OpenCode integration
│       ├── plugins/
│       │   └── suboculo.js    # Event capture plugin
├── install-suboculo.sh        # Claude Code installation script
├── install-suboculo-opencode.sh  # OpenCode installation script
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

**Claude Code:**
```bash
# Install in test project (default port 3000)
./install-suboculo.sh /path/to/test/project

# Or with a custom port
./install-suboculo.sh /path/to/test/project --port 3001

# Restart Claude Code in that project
cd /path/to/test/project
claude  # (with Suboculo hooks loaded)
```

**OpenCode:**
```bash
# Install in test project (default port 3000)
./install-suboculo-opencode.sh /path/to/test/project

# Or with a custom port
./install-suboculo-opencode.sh /path/to/test/project --port 3001

# Restart OpenCode in that project
cd /path/to/test/project
opencode  # (with Suboculo plugin loaded)
```

**Both in same project:**
```bash
# Install both integrations (they share the same database)
./install-suboculo.sh /path/to/test/project
./install-suboculo-opencode.sh /path/to/test/project

# Use either agent - events are captured in shared .suboculo/events.db
```

## Security

Suboculo is **local-first** by default.

### Per-Project Setup (Default)
- Events stored in project's `.suboculo/events.db`
- Backend runs on `localhost` (configurable port, default 3000)
- MCP server communicates via stdio (local)
- No network exposure unless you expose the port
- Data never leaves your machine

### What Gets Stored
- **Event data:** tool names, arguments, outputs, session IDs
- **Agent context:** agent type (Explore, Plan, Bash, etc.) and agent ID
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
# Check backend is running (replace 3000 with your port)
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
---

**Note:** This is v0.1 - per-project architecture. The original centralized design (all projects → one backend) is deprecated in favor of project-specific isolation, especially for sandboxed environments.
