#!/usr/bin/env bash
set -e

# Suboculo Installation Script for OpenCode
# Copies required files and sets up per-project monitoring

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR=""
PORT=3000

# Parse arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      PORT="$2"
      shift 2
      ;;
    *)
      TARGET_DIR="$1"
      shift
      ;;
  esac
done

TARGET_DIR="${TARGET_DIR:-.}"

echo "📊 Installing Suboculo for OpenCode to: $TARGET_DIR (port: $PORT)"
echo ""

# Validate target directory
if [ ! -d "$TARGET_DIR" ]; then
  echo "❌ Error: Target directory does not exist: $TARGET_DIR"
  exit 1
fi

# Create .suboculo directory for shared backend/database
SUBOCULO_DIR="$TARGET_DIR/.suboculo"
mkdir -p "$SUBOCULO_DIR/backend"
mkdir -p "$SUBOCULO_DIR/frontend"

# Create .opencode directory for plugin
OPENCODE_DIR="$TARGET_DIR/.opencode"
mkdir -p "$OPENCODE_DIR/plugins"

# Build frontend
echo "🔨 Building frontend..."
cd "$SCRIPT_DIR/svelte-app"
npm install --silent 2>/dev/null
if ! npm run build >/dev/null 2>&1; then
  echo "❌ Frontend build failed. Running again with output:"
  npm run build
  exit 1
fi
cd "$TARGET_DIR"

# Copy backend files (shared with Claude Code integration)
echo "📋 Copying backend files..."
cp "$SCRIPT_DIR/backend/mcp-analytics-server.mjs" "$SUBOCULO_DIR/backend/"
cp "$SCRIPT_DIR/backend/server.js" "$SUBOCULO_DIR/backend/"
sed -i "s/process.env.SUBOCULO_PORT || 3000/process.env.SUBOCULO_PORT || $PORT/" "$SUBOCULO_DIR/backend/server.js"
cp "$SCRIPT_DIR/backend/cep-processor.js" "$SUBOCULO_DIR/backend/"
cp -r "$SCRIPT_DIR/svelte-app/dist/"* "$SUBOCULO_DIR/frontend/" 2>/dev/null || echo "⚠️  Frontend not built yet (run 'cd svelte-app && npm run build')"

# Copy OpenCode plugin
echo "📋 Copying OpenCode plugin..."
cp "$SCRIPT_DIR/integrations/opencode/plugins/suboculo.js" "$OPENCODE_DIR/plugins/"
sed -i "s/const NOTIFY_PORT = 3000/const NOTIFY_PORT = $PORT/" "$OPENCODE_DIR/plugins/suboculo.js"

# Note: OpenCode uses Bun, and the plugin uses built-in bun:sqlite (no dependencies needed)

# Copy backend package.json
cp "$SCRIPT_DIR/integrations/claude-code/hooks/package.json" "$SUBOCULO_DIR/"

# Install backend dependencies
echo "📦 Installing backend dependencies..."
cd "$SUBOCULO_DIR"
npm install --silent

cd "$TARGET_DIR"

# Create or merge opencode.json
OPENCODE_CONFIG="$TARGET_DIR/opencode.json"
SUBOCULO_MCP="{\"type\":\"local\",\"command\":[\"node\",\"./.suboculo/backend/mcp-analytics-server.mjs\"],\"environment\":{\"SUBOCULO_DB_PATH\":\".suboculo/events.db\",\"SUBOCULO_PORT\":\"$PORT\"},\"enabled\":true}"

if [ -f "$OPENCODE_CONFIG" ] && [ -s "$OPENCODE_CONFIG" ]; then
  echo "⚙️  Merging suboculo into existing opencode.json..."
  TEMP_FILE=$(mktemp)
  jq --argjson srv "$SUBOCULO_MCP" '.mcp.suboculo = $srv' "$OPENCODE_CONFIG" > "$TEMP_FILE"
  mv "$TEMP_FILE" "$OPENCODE_CONFIG"
else
  echo "⚙️  Generating opencode.json..."
  jq -n --argjson srv "$SUBOCULO_MCP" '{mcp: {suboculo: $srv}}' > "$OPENCODE_CONFIG"
fi

# Create .gitignore entries
if [ -f "$TARGET_DIR/.gitignore" ]; then
  if ! grep -q "^\.suboculo/$" "$TARGET_DIR/.gitignore" 2>/dev/null; then
    echo "📝 Adding .suboculo/ to .gitignore..."
    echo ".suboculo/" >> "$TARGET_DIR/.gitignore"
  fi
fi

echo ""
echo "✅ Suboculo for OpenCode installed successfully!"
echo ""
echo "📌 Next steps:"
echo ""
echo "1. Restart OpenCode"
echo "2. Run any tool to generate events"
echo "3. Query via MCP: 'What tools have I used?'"
echo "4. Start web UI: cd $TARGET_DIR && node ./.suboculo/backend/server.js"
echo "   Then open http://localhost:$PORT"
echo ""
echo "📊 Data stored in: .suboculo/events.db"
echo "🔧 MCP server configured in: opencode.json"
echo "🌐 Web UI available at: .suboculo/backend/server.js"
echo "🔌 Plugin installed at: .opencode/plugins/suboculo.js"
echo ""
