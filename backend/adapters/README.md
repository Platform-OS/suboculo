# CEP Adapters

Adapters that translate runner-specific log formats to Common Event Protocol (CEP).

## Available Adapters

### OpenCode Adapter

**File:** `opencode.js`

Translates OpenCode's native log format to CEP.

**Mapping:**

| OpenCode Event | CEP Event | Notes |
|---|---|---|
| `init` | `session.start` | Includes directory |
| `session.event` (type=created) | `session.start` | Includes title |
| `session.event` (type=updated) | `session.update` | Title changes |
| `session.event` (type=status) | *(skipped)* | Noise |
| `session.event` (type=diff) | *(skipped)* | Noise |
| `tool.before` | `tool.start` | Creates traceId from callID |
| `tool.after` | `tool.end` | Pairs with tool.start via traceId |
| `task.spawn` | `subagent.spawn` | Subagent creation |
| `message.toolpart` | `message` | LLM output |

**Usage:**

```javascript
const OpenCodeAdapter = require('./adapters/opencode.js');

const adapter = new OpenCodeAdapter();
const cepEvent = adapter.translate(opencodeEvent);

// Or batch
const cepEvents = adapter.translateBatch(opencodeEvents);
```

**CLI Tool:**

```bash
# Convert entire file
node adapters/convert-opencode.js input.jsonl output.jsonl

# Preview first 10 conversions
node adapters/convert-opencode.js input.jsonl output.jsonl --preview 10
```

**Tests:**

```bash
node adapters/opencode.test.js
```

### Claude Code Adapter

**Status:** Coming in Step 3

Will translate Claude Code's tool use events (from hooks) to CEP format.

## Creating New Adapters

To add support for a new runner:

1. **Create adapter file:** `adapters/{runner-name}.js`
2. **Implement class:** Follow the pattern in `opencode.js`
   - Constructor: Initialize any state tracking
   - `translate(event)`: Single event translation
   - `translateBatch(events)`: Batch translation
3. **Map events:** Translate to CEP event types
4. **Preserve data:** Use `meta` object for runner-specific fields
5. **Write tests:** Create `{runner-name}.test.js`
6. **Document:** Add mapping table to this README

## Adapter Guidelines

From `CEP-SPEC.md`:

1. **Preserve timestamps**: Use the runner's original timestamp
2. **Generate IDs consistently**: SessionId and traceId must be stable
3. **Map status codes**: Translate to CEP status enum (success, error, timeout, cancelled)
4. **Preserve original data**: Put runner-specific fields in `meta` object
5. **Pair events**: tool.start and tool.end must use the same `traceId`

## Testing Adapters

Each adapter should have a test file that verifies:

- ✅ All event types translate correctly
- ✅ Required fields are present
- ✅ Data is preserved accurately
- ✅ Batch translation works
- ✅ Null/undefined handling
- ✅ Edge cases (missing fields, malformed data)

Run all tests:

```bash
find adapters -name "*.test.js" -exec node {} \;
```
