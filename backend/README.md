# Agent Actions Log Viewer - Backend

Node.js + Express + SQLite backend for handling large log files.

## Features

- **SQLite Database** - Handles files of any size (900MB+)
- **Indexed Queries** - Fast filtering and searching
- **REST API** - Clean API for frontend
- **Persistent Storage** - Database persists between sessions
- **Tags & Notes** - Stored in database, not browser

## Installation

```bash
npm install
```

## Usage

```bash
npm start
```

Server runs on `http://localhost:3000`

## API Endpoints

### Upload
- `POST /api/upload` - Upload JSONL file (creates/replaces database)

### Query
- `GET /api/entries?page=1&pageSize=100&kind=tool.after...` - Get paginated entries
- `GET /api/facets` - Get unique values for filters (kinds, types, tools, etc.)
- `GET /api/stats` - Get statistics (total entries, avg duration)

### Tags & Notes
- `GET /api/tags` - Get all tags
- `POST /api/tags` - Add/remove tag `{entryKey, tag, action: "add"|"remove"}`
- `GET /api/notes` - Get all notes
- `POST /api/notes` - Set note `{entryKey, note}`

### Import/Export
- `GET /api/export` - Export tags and notes as JSON
- `POST /api/import` - Import tags and notes `{tagsByKey, notesByKey}`

## Database Schema

```sql
entries (
  key TEXT PRIMARY KEY,
  ts, kind, type, tool,
  sessionID, rootSessionID, subagentType,
  callID, durationMs, args, data, ...
)

tags (entry_key, tag)
notes (entry_key, note)
```

## Performance

- Indexed columns: kind, type, tool, ts, sessionID, rootSessionID
- Batch inserts (1000 entries at a time)
- Transaction-based operations

## File Structure

```
backend/
├── server.js       # Express server + API
├── actions.db      # SQLite database (created on first upload)
├── uploads/        # Temporary upload directory
└── package.json
```
