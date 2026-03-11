# Quick Installation Guide

## 1. Prerequisites

Install required tools:

```bash
# Check Claude Code version (need 1.0.33+)
claude --version

# Install jq (if not already installed)
brew install jq    # macOS
# or
apt-get install jq # Debian/Ubuntu
```

## 2. Start the Backend

```bash
# In the suboculo directory
cd backend
npm install
npm start

# Backend should be running on http://localhost:3000
```

## 3. Start the Frontend

```bash
# In another terminal
cd svelte-app
npm install
npm run dev

# Frontend should be running on http://localhost:5173
```

## 4. Install the Plugin

### Option A: From GitHub (once published)

```bash
claude
/plugin install github:your-org/suboculo/integrations/claude-code
```

### Option B: Local Installation (for development)

```bash
# From the suboculo directory
claude --plugin-dir ./integrations/claude-code
```

## 5. Verify It's Working

1. **In Claude Code**, run a simple command:
   ```
   run `pwd`
   ```

2. **Open the viewer**: http://localhost:5173

3. **Filter by runner**: Select "claude-code" from the Runner dropdown

4. **You should see**:
   - `session.start` event
   - `tool.start` event (Bash)
   - `tool.end` event (Bash)

## 6. Check Hook Status

In Claude Code, verify hooks are loaded:

```
/hooks
```

You should see:
- PreToolUse hook with matcher: `.*`
- PostToolUse hook with matcher: `.*`
- SessionStart hook

## Troubleshooting

### Events not appearing?

```bash
# 1. Test backend
curl http://localhost:3000/api/facets

# 2. Test jq
jq --version

# 3. Check plugin is enabled
/plugin list

# 4. Check hooks menu
/hooks
```

### Backend on different port?

Edit `integrations/claude-code/hooks/hooks.json` and replace `localhost:3000` with your backend URL, then restart Claude Code.

## Next Steps

- See [README.md](README.md) for full documentation
- See [../backend/CLAUDE-CODE-INTEGRATION.md](../backend/CLAUDE-CODE-INTEGRATION.md) for advanced configuration
