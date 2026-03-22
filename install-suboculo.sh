#!/usr/bin/env bash
set -e

# Suboculo Installation Script
# Copies required files and sets up per-project monitoring

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR=""
PORT=3000
MANUAL_MERGE=false

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "❌ Error: Required command not found: $1"
    exit 1
  fi
}

patch_port_in_file() {
  local file="$1"
  local pattern="$2"
  local replacement="$3"
  node -e '
    const fs = require("fs");
    const [file, pattern, replacement] = process.argv.slice(1);
    const input = fs.readFileSync(file, "utf8");
    const output = input.split(pattern).join(replacement);
    if (input === output) {
      console.error(`❌ Error: Failed to patch ${file}; pattern not found: ${pattern}`);
      process.exit(1);
    }
    fs.writeFileSync(file, output);
  ' "$file" "$pattern" "$replacement"
}

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

# Preflight checks before mutating target project
require_cmd node
require_cmd npm
require_cmd jq
require_cmd mktemp

# Create .suboculo directory with mirrored structure
SUBOCULO_DIR="$TARGET_DIR/.suboculo"
mkdir -p "$SUBOCULO_DIR/integrations/claude-code"
mkdir -p "$SUBOCULO_DIR/backend"
mkdir -p "$SUBOCULO_DIR/frontend"

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

# Copy files from monorepo structure
echo "📋 Copying files..."
cp "$SCRIPT_DIR/integrations/claude-code/hooks/event-writer.mjs" "$SUBOCULO_DIR/integrations/claude-code/"
patch_port_in_file "$SUBOCULO_DIR/integrations/claude-code/event-writer.mjs" "const NOTIFY_PORT = 3000" "const NOTIFY_PORT = $PORT"
cp "$SCRIPT_DIR/backend/mcp-analytics-server.mjs" "$SUBOCULO_DIR/backend/"
cp "$SCRIPT_DIR/backend/server.js" "$SUBOCULO_DIR/backend/"
cp "$SCRIPT_DIR/backend/logger.js" "$SUBOCULO_DIR/backend/"
patch_port_in_file "$SUBOCULO_DIR/backend/server.js" "process.env.SUBOCULO_PORT || 3000" "process.env.SUBOCULO_PORT || $PORT"
cp "$SCRIPT_DIR/backend/cep-processor.js" "$SUBOCULO_DIR/backend/"
cp -r "$SCRIPT_DIR/svelte-app/dist/"* "$SUBOCULO_DIR/frontend/"
cp "$SCRIPT_DIR/integrations/claude-code/hooks/package.json" "$SUBOCULO_DIR/"
if [ -f "$SCRIPT_DIR/.suboculo/thresholds.example.json" ]; then
  cp "$SCRIPT_DIR/.suboculo/thresholds.example.json" "$SUBOCULO_DIR/thresholds.example.json"
fi

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
HOOKS_JSON=$(jq --arg port "$PORT" '
  .hooks
  | walk(if type == "string" then gsub("localhost:3000"; "localhost:" + $port) else . end)
' "$SCRIPT_DIR/integrations/claude-code/hooks/hooks.json")

# Check if settings file exists
if [ -f "$SETTINGS_FILE" ] && [ -s "$SETTINGS_FILE" ]; then
  echo "📝 Merging hooks into existing settings..."
  TEMP_FILE=$(mktemp)
  jq --argjson hooks "$HOOKS_JSON" '
    .hooks = (
      (.hooks // {}) as $existing
      | reduce ($hooks | keys[]) as $event ({};
          .[$event] = (
            (
              ($existing[$event] // [])
              | map(
                  if (
                    ([.hooks[]?.command? // empty] | any(contains(".suboculo/integrations/claude-code/event-writer.mjs")))
                  )
                  then empty
                  else .
                  end
                )
            ) + ($hooks[$event] // [])
          )
        )
      | $existing + .
    )
  ' "$SETTINGS_FILE" > "$TEMP_FILE"
  mv "$TEMP_FILE" "$SETTINGS_FILE"
  echo "✅ Hooks merged into $SETTINGS_FILE"
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
