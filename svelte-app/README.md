# Agent Actions Log Viewer

A modern, lightweight Svelte application for viewing and analyzing agent action logs in JSONL format.

## Features

- **Upload JSONL files** - Load agent action logs for analysis
- **Powerful filtering** - Filter by kind, tool, subagent, root session, and tags
- **Search** - Full-text search across all log fields, tags, and notes
- **Sorting** - Sort by timestamp, duration, tool, or kind (ascending/descending)
- **Tagging** - Add custom tags to entries for categorization
- **Notes** - Add notes to individual entries for documentation
- **Pagination** - Handle large log files with configurable page sizes
- **Export/Import** - Export and import tags and notes as JSON
- **Light theme** - Clean, modern light theme design
- **Local storage** - Tags and notes persist in browser localStorage

## Tech Stack

- **Svelte** - Reactive UI framework
- **Vite** - Fast build tool and dev server
- **Tailwind CSS** - Utility-first CSS framework
- **Lucide Icons** - Beautiful icon set
- **shadcn-svelte inspired** - Modern, accessible UI components

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm

### Installation

\`\`\`bash
npm install
\`\`\`

### Development

\`\`\`bash
npm run dev
\`\`\`

The app will be available at \`http://localhost:5173\`

### Build

\`\`\`bash
npm run build
\`\`\`

### Preview Production Build

\`\`\`bash
npm run preview
\`\`\`

## Usage

1. **Upload a log file** - Click "Upload JSONL" and select your \`agent-actions.jsonl\` file
2. **Filter entries** - Use the filter dropdowns to narrow down entries by kind, tool, subagent, etc.
3. **Search** - Use the search box to find specific entries
4. **Sort** - Change the sort key and direction to organize entries
5. **Select an entry** - Click on any row to view details
6. **Add tags** - In the details panel, use the Tags tab to add custom tags
7. **Add notes** - Use the Notes tab to add detailed notes about specific entries
8. **Export tags** - Click "Export tags" to save your tags and notes as JSON
9. **Import tags** - Click "Import tags" to restore previously exported tags and notes

## Log File Format

The application expects JSONL (JSON Lines) format where each line is a valid JSON object. Example entry:

\`\`\`json
{"ts":"2026-02-27T17:25:20.260Z","kind":"tool.after","sessionID":"ses_xxx","rootSessionID":"ses_xxx","callID":"call_xxx","tool":"read","durationMs":4,"args":{"filePath":"/path/to/file"}}
\`\`\`

Common fields:
- \`ts\` - Timestamp (ISO 8601 format)
- \`kind\` - Event type (e.g., "tool.before", "tool.after", "session.event", "init")
- \`tool\` - Tool name (e.g., "read", "write", "bash")
- \`sessionID\` - Session identifier
- \`rootSessionID\` - Root session identifier
- \`subagentType\` - Subagent type (if applicable)
- \`callID\` - Call identifier
- \`durationMs\` - Duration in milliseconds (for "tool.after" events)
- \`args\` - Tool arguments object

## Project Structure

\`\`\`
svelte-app/
├── src/
│   ├── lib/
│   │   ├── components/
│   │   │   ├── ui/          # Reusable UI components
│   │   │   └── AgentActionsLogViewer.svelte  # Main component
│   │   └── utils.js         # Utility functions
│   ├── app.css              # Global styles with Tailwind
│   ├── App.svelte           # Root component
│   └── main.js              # Application entry point
├── public/                  # Static assets
├── index.html               # HTML template
└── package.json
\`\`\`

## License

MIT
