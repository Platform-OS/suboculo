const fs = require('fs');
const path = require('path');
const { insertCEPEvent, insertCEPEventsBatch, validateCEPEvent } = require('./cep-processor');
const EventEmitter = require('events');
const logger = require('./logger');
const { createApp } = require('./app');
const { initDatabase } = require('./db/init');
const {
  OUTCOME_LABELS,
  EVALUATION_TYPES,
  FAILURE_TAXONOMY,
  FAILURE_MODES,
  OUTCOME_LABELS_REQUIRING_FAILURE_MODE,
  KPI_MIN_CANONICAL_SAMPLE,
  KPI_MIN_SUCCESS_SAMPLE_FOR_COST,
  DEFAULT_KPI_TARGETS
} = require('./domain/taxonomy');
const { createOutcomesDomain } = require('./domain/outcomes');
const { createReliabilityDomain } = require('./domain/reliability');
const { createTaskRunsDomain } = require('./domain/task-runs');
const { createTaskRunsRepository } = require('./repositories/task-runs-repository');
const { createOutcomesRepository } = require('./repositories/outcomes-repository');
const { createReliabilityRepository } = require('./repositories/reliability-repository');
const { createReviewAcknowledgementsRepository } = require('./repositories/review-acknowledgements-repository');
const { registerReliabilityRoutes } = require('./routes/reliability');
const { registerTaskRunRoutes } = require('./routes/task-runs');
const { registerEntriesRoutes } = require('./routes/entries');
const { registerAnalysesRoutes } = require('./routes/analyses');
const { registerAnnotationRoutes } = require('./routes/annotations');
const { registerMetaRoutes } = require('./routes/meta');
const { registerBenchmarkRoutes } = require('./routes/benchmarks');
const { registerRuntimeRoutes } = require('./routes/runtime');

const PORT = process.env.SUBOCULO_PORT || 3000;
const HOST = process.env.SUBOCULO_HOST || '127.0.0.1';
const AUTO_LABEL_ENABLED = String(process.env.SUBOCULO_AUTO_LABEL ?? 'true').toLowerCase() !== 'false';
const KPI_THRESHOLDS_PATH = process.env.SUBOCULO_THRESHOLDS_PATH || path.join(process.cwd(), '.suboculo', 'thresholds.json');

// SSE Event Emitter for real-time updates
const sseEmitter = new EventEmitter();
sseEmitter.setMaxListeners(100); // Support up to 100 concurrent SSE connections

const frontendPath = path.join(__dirname, '../frontend');
const app = createApp({ frontendPath, logger });

// Database setup
// Defaults to ../events.db for per-project, or set SUBOCULO_DB_PATH for custom location
const dbPath = process.env.SUBOCULO_DB_PATH || path.join(__dirname, '../events.db');
const db = initDatabase({ dbPath, logger });

const taskRunsRepository = createTaskRunsRepository(db);
const outcomesRepository = createOutcomesRepository(db);
const reliabilityRepository = createReliabilityRepository(db);
const reviewAcknowledgementsRepository = createReviewAcknowledgementsRepository(db);

const outcomesDomain = createOutcomesDomain({
  outcomesRepository,
  taskRunsRepository,
  normalizeOptionalString,
  autoLabelEnabled: AUTO_LABEL_ENABLED
});

const taskRunsDomain = createTaskRunsDomain({
  taskRunsRepository,
  outcomesRepository,
  parseJSONSafe,
  autoLabelTaskRunIfEligible: outcomesDomain.autoLabelTaskRunIfEligible
});

const reliabilityDomain = createReliabilityDomain({
  reliabilityRepository,
  reviewAcknowledgementsRepository,
  fs,
  logger,
  thresholdsPath: KPI_THRESHOLDS_PATH,
  buildTaskRunsWhereClause: taskRunsDomain.buildTaskRunsWhereClause,
  normalizeOptionalString
});

const {
  validateOutcomePayload,
  insertOutcomeForTaskRun
} = outcomesDomain;

const {
  buildTaskRunsWhereClause,
  upsertTaskRunForRootSession,
  getTaskRunById,
  buildTaskRunAfterActionReport,
  getStoredTaskRunAfterActionReport,
  upsertStoredTaskRunAfterActionReport,
  isStoredTaskRunReportFresh,
  backfillAllTaskRuns
} = taskRunsDomain;

const {
  getConfiguredKpiTargets,
  buildReliabilityTrendsData,
  buildFailureModeTrendsData,
  fetchReliabilityRows,
  summarizeReliabilityKpis,
  deriveKpiAnomalies,
  buildReliabilityReviewData,
  getKpiComparePeriods,
  buildKpiCompareDeltas
} = reliabilityDomain;

// Helper: Generate unique key for entry
function generateKey(entry, idx) {
  const callId = entry?.callID || entry?.callId;
  if (callId && entry?.kind && entry?.ts) {
    return `${callId}::${entry.kind}::${entry.ts}`;
  }
  if (callId && entry?.kind) {
    return `${callId}::${entry.kind}::${idx}`;
  }
  if (entry?.sessionID && entry?.ts) {
    return `${entry.sessionID}::${entry.ts}::${idx}`;
  }
  return `idx::${idx}`;
}

// Decode base64-encoded fields from hooks (safe shell transport → readable storage)
function decodeBase64Fields(event) {
  if (!event.data) return;
  for (const field of ['args', 'response']) {
    if (typeof event.data[field] !== 'string') continue;
    try {
      event.data[field] = JSON.parse(Buffer.from(event.data[field], 'base64').toString('utf-8'));
    } catch {
      // Not base64 or not JSON — leave as-is
    }
  }
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJSONSafe(value, fallback = null) {
  const parsed = tryParseJson(value);
  return parsed === null ? fallback : parsed;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeIsoTimestampOrNull(value) {
  const str = normalizeOptionalString(value);
  if (!str) return null;
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

const initialDerivedTaskRuns = backfillAllTaskRuns();
logger.info(`[suboculo] Derived task runs on startup: ${initialDerivedTaskRuns}`);

// Generate SSE key — must match generateCEPKey logic for consistent dedup
function sseKey(event) {
  if (event.traceId && event.event) {
    return `${event.traceId}::${event.event}::${event.ts}`;
  }
  // Usage events: unique by session + model + agent + timestamp
  if (event.event === 'usage' && event.sessionId) {
    const agent = event.data?.agentId || 'lead';
    const model = event.data?.model || 'unknown';
    return `usage::${event.sessionId}::${model}::${agent}::${event.ts}`;
  }
  const agentId = event.data?.agentId;
  if (agentId && event.sessionId && event.event) {
    return `${event.sessionId}::${event.event}::${agentId}::${event.ts}`;
  }
  return `${event.sessionId || 'unknown'}::${event.event}::${event.ts}`;
}

registerTaskRunRoutes(app, {
  taskRunsRepository,
  outcomesRepository,
  parseJSONSafe,
  backfillAllTaskRuns,
  buildTaskRunsWhereClause,
  getTaskRunById,
  getStoredTaskRunAfterActionReport,
  isStoredTaskRunReportFresh,
  buildTaskRunAfterActionReport,
  upsertStoredTaskRunAfterActionReport,
  validateOutcomePayload,
  insertOutcomeForTaskRun
});

registerReliabilityRoutes(app, {
  reviewAcknowledgementsRepository,
  KPI_MIN_CANONICAL_SAMPLE,
  KPI_MIN_SUCCESS_SAMPLE_FOR_COST,
  getConfiguredKpiTargets,
  fetchReliabilityRows,
  summarizeReliabilityKpis,
  deriveKpiAnomalies,
  getKpiComparePeriods,
  buildKpiCompareDeltas,
  buildReliabilityTrendsData,
  buildFailureModeTrendsData,
  buildReliabilityReviewData,
  normalizeIsoTimestampOrNull,
  normalizeOptionalString
});

registerEntriesRoutes(app, {
  db,
  logger,
  tryParseJson,
  decodeBase64Fields
});

registerAnalysesRoutes(app, {
  db,
  logger,
  tryParseJson,
  callAnthropicAPI
});

registerAnnotationRoutes(app, {
  db,
  dbPath,
  fs,
  path,
  logger,
  tryParseJson,
  decodeBase64Fields
});

registerMetaRoutes(app, {
  EVALUATION_TYPES,
  OUTCOME_LABELS,
  FAILURE_MODES,
  FAILURE_TAXONOMY,
  OUTCOME_LABELS_REQUIRING_FAILURE_MODE
});

registerBenchmarkRoutes(app, {
  db,
  parseJSONSafe
});

registerRuntimeRoutes(app, {
  db,
  logger,
  sseEmitter,
  tryParseJson,
  decodeBase64Fields,
  sseKey,
  validateCEPEvent,
  insertCEPEvent,
  insertCEPEventsBatch,
  upsertTaskRunForRootSession
});

// Helper function to call Anthropic API
async function callAnthropicAPI(model, systemPrompt, userMessage, apiKey) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

// Start server
app.listen(PORT, HOST, () => {
  logger.info(`Server running on http://${HOST}:${PORT}`);
  logger.info(`Database: ${dbPath}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('\nClosing database...');
  db.close();
  process.exit(0);
});
