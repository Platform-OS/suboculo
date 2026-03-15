#!/usr/bin/env bash
set -e

# Suboculo Installation Script
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

echo "📊 Installing Suboculo to: $TARGET_DIR (port: $PORT)"
echo ""

# Validate target directory
if [ ! -d "$TARGET_DIR" ]; then
  echo "❌ Error: Target directory does not exist: $TARGET_DIR"
  exit 1
fi

# Create .suboculo directory with mirrored structure
SUBOCULO_DIR="$TARGET_DIR/.suboculo"
mkdir -p "$SUBOCULO_DIR/integrations/claude-code"
mkdir -p "$SUBOCULO_DIR/backend"
mkdir -p "$SUBOCULO_DIR/frontend"

# Copy files from monorepo structure
echo "📋 Copying files..."
cp "$SCRIPT_DIR/integrations/claude-code/hooks/event-writer.mjs" "$SUBOCULO_DIR/integrations/claude-code/"
cp "$SCRIPT_DIR/backend/mcp-analytics-server.mjs" "$SUBOCULO_DIR/backend/"
cp "$SCRIPT_DIR/backend/server.js" "$SUBOCULO_DIR/backend/"
sed -i "s/process.env.SUBOCULO_PORT || 3000/process.env.SUBOCULO_PORT || $PORT/" "$SUBOCULO_DIR/backend/server.js"
cp "$SCRIPT_DIR/backend/cep-processor.js" "$SUBOCULO_DIR/backend/"
cp -r "$SCRIPT_DIR/svelte-app/dist/"* "$SUBOCULO_DIR/frontend/" 2>/dev/null || echo "⚠️  Frontend not built yet (run 'cd svelte-app && npm run build')"
cp "$SCRIPT_DIR/integrations/claude-code/hooks/package.json" "$SUBOCULO_DIR/"

# Install dependencies
echo "📦 Installing dependencies..."
cd "$SUBOCULO_DIR"
npm install --silent

# Create or merge .mcp.json
MCP_FILE="$TARGET_DIR/.mcp.json"
SUBOCULO_MCP="{\"command\":\"node\",\"args\":[\"./.suboculo/backend/mcp-analytics-server.mjs\"],\"env\":{\"SUBOCULO_DB_PATH\":\".suboculo/events.db\",\"SUBOCULO_PORT\":\"$PORT\"}}"

if [ -f "$MCP_FILE" ] && [ -s "$MCP_FILE" ]; then
  echo "⚙️  Merging suboculo into existing .mcp.json..."
  TEMP_FILE=$(mktemp)
  jq --argjson srv "$SUBOCULO_MCP" '.mcpServers.suboculo = $srv' "$MCP_FILE" > "$TEMP_FILE"
  mv "$TEMP_FILE" "$MCP_FILE"
else
  echo "⚙️  Generating .mcp.json..."
  jq -n --argjson srv "$SUBOCULO_MCP" '{mcpServers: {suboculo: $srv}}' > "$MCP_FILE"
fi

# Create .gitignore entry
if [ -f "$TARGET_DIR/.gitignore" ]; then
  if ! grep -q "^\.suboculo/$" "$TARGET_DIR/.gitignore" 2>/dev/null; then
    echo "📝 Adding .suboculo/ to .gitignore..."
    echo ".suboculo/" >> "$TARGET_DIR/.gitignore"
  fi
fi

# Configure hooks
echo "🔗 Configuring hooks..."
CLAUDE_DIR="$TARGET_DIR/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.local.json"

mkdir -p "$CLAUDE_DIR"

# Load hooks from source file, replacing default port with configured port
HOOKS_JSON=$(jq '.hooks' "$SCRIPT_DIR/integrations/claude-code/hooks/hooks.json" | sed "s|localhost:3000|localhost:$PORT|g")

# Check if settings file exists
if [ -f "$SETTINGS_FILE" ] && [ -s "$SETTINGS_FILE" ]; then
  # File exists - merge using jq
  if command -v jq &> /dev/null; then
    echo "📝 Merging hooks into existing settings..."
    TEMP_FILE=$(mktemp)
    jq --argjson hooks "$HOOKS_JSON" '.hooks = $hooks' "$SETTINGS_FILE" > "$TEMP_FILE"
    mv "$TEMP_FILE" "$SETTINGS_FILE"
    echo "✅ Hooks merged into $SETTINGS_FILE"
  else
    echo "⚠️  Warning: jq not found - cannot auto-merge hooks"
    echo "   $SETTINGS_FILE already exists"
    echo "   Please manually add the hooks configuration shown below."
    echo ""
    MANUAL_MERGE=true
  fi
else
  # Create new settings file using jq to properly construct JSON
  jq -n --argjson hooks "$HOOKS_JSON" '{hooks: $hooks}' > "$SETTINGS_FILE"
  echo "✅ Hooks configured in $SETTINGS_FILE"
fi

echo ""
echo "✅ Suboculo installed successfully!"
echo ""

if [ "$MANUAL_MERGE" = true ]; then
  echo "📋 Add this to your existing .claude/settings.local.json:"
  echo ""
  jq -n --argjson hooks "$HOOKS_JSON" '{hooks: $hooks}'
  echo ""
fi

echo "📌 Next steps:"
echo ""
echo "1. Restart Claude Code"
echo "2. Run any tool to generate events"
echo "3. Query via MCP: 'What tools have I used?'"
echo "4. Start web UI: cd $TARGET_DIR && node ./.suboculo/backend/server.js"
echo "   Then open http://localhost:$PORT"
echo ""
echo "📊 Data stored in: .suboculo/events.db"
echo "🔧 MCP server configured and ready"
echo "🌐 Web UI available at: .suboculo/backend/server.js"
echo ""
