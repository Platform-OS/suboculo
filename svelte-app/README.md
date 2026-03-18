# Suboculo Viewer

Frontend viewer for the Suboculo AI agent monitoring platform.

## Features

- **Real-time updates** - Live event stream via SSE
- **Powerful filtering** - Filter by runner, event type, tool, agent, session, and tags
- **Search** - Full-text search across all log fields, tags, and notes
- **Sorting** - Sort by timestamp, duration, tool, or event type
- **Tagging** - Add custom tags to entries for categorization
- **Notes** - Add notes to individual entries
- **Pagination** - Handle large datasets with configurable page sizes
- **Export/Import** - Export and import tags and notes as JSON
- **Analysis** - Analyze selected events via the Anthropic API
- **Selection bridge** - Save event selections for CLI-based MCP analysis

## Tech Stack

- **Svelte** - Reactive UI framework
- **Vite** - Fast build tool and dev server
- **Tailwind CSS** - Utility-first CSS framework
- **Lucide Icons** - Icon set
- **DOMPurify** - HTML sanitization for rendered markdown

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

The app will be available at `http://localhost:5173`

### Build

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

## Usage

1. **Install Suboculo** in a project using `install-suboculo.sh` or `install-suboculo-opencode.sh`
2. **Start the backend** - `node .suboculo/backend/server.js`
3. **Use your agent** - Events appear in real-time via SSE
4. **Filter entries** - Use the filter dropdowns to narrow down by runner, event, tool, etc.
5. **Search** - Use the search box to find specific entries
6. **Select an entry** - Click on any row to view details
7. **Add tags** - In the details panel, use the Tags tab to add custom tags
8. **Add notes** - Use the Notes tab to add detailed notes about specific entries
9. **Analyze** - Select events and run LLM analysis via the Anthropic API
10. **Export tags** - Click "Export tags" to save your annotations as JSON
11. **Import tags** - Click "Import tags" to restore previously exported annotations

## Project Structure

```
svelte-app/
├── src/
│   ├── lib/
│   │   ├── components/
│   │   │   ├── ui/          # Reusable UI components
│   │   │   └── AgentActionsLogViewer.svelte  # Main component
│   │   ├── api.js           # API client
│   │   └── utils.js         # Utility functions
│   ├── app.css              # Global styles with Tailwind
│   ├── App.svelte           # Root component
│   └── main.js              # Application entry point
├── public/                  # Static assets
├── index.html               # HTML template
└── package.json
```