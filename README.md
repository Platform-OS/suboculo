# Suboculo

***Agens sub oculo*** - Agent under the eye

Real-time monitoring and analytics platform for AI coding agents.

## Architecture

**Frontend:** Svelte + Vite + Tailwind CSS + shadcn-svelte
**Backend:** Node.js + Express + SQLite (better-sqlite3)

## Why SQLite Backend?

✅ **Handles huge files** - 900MB, 9GB, or larger
✅ **Fast queries** - Indexed searches return results instantly
✅ **Low memory usage** - Only loads filtered results
✅ **Persistent storage** - No re-parsing on reload
✅ **Real database** - Complex queries, aggregations, full-text search

## Quick Start

### 1. Start Backend (Terminal 1)

```bash
cd backend
npm install
npm start
```

Backend runs on `http://localhost:3000`

### 2. Start Frontend (Terminal 2)

```bash
cd svelte-app
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`

### 3. Use the App

1. Open `http://localhost:5173` in your browser
2. Click **"Upload JSONL"** and select your large log file
3. Wait for import (progress shown in console)
4. Filter, search, tag, and analyze!

## What It Does

Monitor and analyze AI coding agents in real-time:

- ✅ **Claude Code integration** - Real-time monitoring via plugin ([installation guide](./integrations/claude-code/))
- ✅ **Real-time streaming** - Server-Sent Events for live session monitoring
- ✅ **LLM-powered analysis** - Analyze agent behavior patterns with Claude
- ✅ **Session tracking** - Correlate events across agent sessions
- ✅ **Persistent storage** - SQLite backend handles unlimited event history
- ✅ **Rich filtering** - By runner, tool, event type, session, or custom tags
- ✅ **Analysis history** - Save and review past LLM analyses
- 🚧 **OpenCode & Codex CLI** - Integrations planned

## Features

### Real-time Monitoring
- Live event streaming via SSE
- Session start/end tracking
- Tool execution timing
- Success/error status monitoring

### Analysis & Insights
- LLM-powered workflow analysis
- Custom prompts for specific insights
- Analysis history with export
- Event correlation and patterns

### Data Management
- SQLite backend for massive datasets
- Tag and annotate events
- Full-text search
- Export/import capabilities

## How It Works

```
User uploads 900MB JSONL
        ↓
Backend parses line-by-line
        ↓
Inserts into SQLite with indexes
        ↓
Frontend sends filter/search query
        ↓
Backend runs SQL query
        ↓
Returns only matching results (paginated)
        ↓
Frontend displays results
```

## Performance

**Old approach (client-side):**
- ❌ 900MB file → Browser crashes
- ❌ All data in memory
- ❌ Slow filtering

**New approach (SQLite):**
- ✅ 900MB file → Imports in ~30 seconds
- ✅ ~50MB in memory (only DB connection)
- ✅ Instant filtering (indexed queries)

## API Endpoints

See `backend/README.md` for full API documentation.

## Project Structure

```
suboculo/
├── backend/              # Node.js + Express + SQLite
│   ├── server.js
│   ├── adapters/        # Event format processors
│   └── actions.db       # SQLite database (auto-created)
├── svelte-app/          # Frontend viewer
│   └── src/
│       ├── lib/
│       │   ├── api.js
│       │   └── components/
│       └── App.svelte
├── integrations/        # Client-side integrations
│   └── claude-code/    # Claude Code plugin
│       └── hooks/
└── docs/               # Documentation
```

## Development

### Backend
```bash
cd backend
npm run dev  # Node.js with auto-reload (add nodemon)
```

### Frontend
```bash
cd svelte-app
npm run dev  # Vite dev server with HMR
```

## Security

Suboculo is designed as a **local-first tool**. By default, everything runs on localhost and never leaves your machine.

### Default Setup (localhost)

In the default configuration:

- **Backend** listens on `localhost:3000`
- **Frontend** runs on `localhost:5173`
- **Integrations** send events to `localhost:3000`
- **CORS** is permissive — this is intentional for local development
- **No authentication** is required — your machine, your data
- **LLM analysis API keys** travel from your browser to your local backend to the Anthropic API — they never touch a third-party server

This is safe for single-user, local use.

### Network / Team Deployment

If you expose Suboculo on a network (e.g., for a team), you **must** add:

1. **HTTPS** — API keys and event data will travel over the network
2. **Authentication** — without it, anyone who can reach port 3000 can read your data, inject events, or trigger LLM analysis
3. **CORS restrictions** — lock down `cors()` in `server.js` to your specific origin
4. **Reverse proxy** — use nginx or similar to terminate TLS and manage access

Suboculo does not currently include built-in authentication. This is a deliberate choice for v0.1 to keep the local setup simple. Network auth support is planned for a future release.

### What Gets Stored

- **Event data** — tool names, arguments, file paths, command outputs, session IDs
- **Analysis history** — LLM analysis results and the events they were run against
- **Tags and notes** — your annotations on events

All data is stored locally in `backend/actions.db` (SQLite). No data is sent externally unless you explicitly run an LLM analysis, which sends selected events to the Anthropic API using your own API key.

## Production Build

### Frontend
```bash
cd svelte-app
npm run build
npm run preview
```

### Backend
```bash
cd backend
npm start
```

For production, consider:
- Using PM2 or systemd to run backend
- Serving frontend build with nginx
- See [Security](#security) section for network deployment requirements

## Troubleshooting

### Backend won't start
```bash
cd backend
rm actions.db  # Delete old database
npm start
```

### Frontend can't connect to backend
- Ensure backend is running on `http://localhost:3000`
- Check browser console for CORS errors
- Verify `src/lib/api.js` has correct API_BASE URL

### Upload fails
- Check file is valid JSONL (one JSON object per line)
- Check backend console for errors
- Ensure `backend/uploads/` directory exists

## License

MIT
