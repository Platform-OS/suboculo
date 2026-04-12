const { z } = require('zod');

function formatZodError(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code
  }));
}

function parseOrRespond(schema, input, res) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  res.status(400).json({
    error: 'Invalid request',
    details: formatZodError(result.error)
  });
  return null;
}

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50)
}).passthrough();

const taskRunListQuerySchema = paginationQuerySchema.extend({
  sortKey: z.enum(['started_at', 'ended_at', 'updated_at', 'total_events', 'total_duration_ms', 'estimated_cost']).default('started_at'),
  sortDir: z.enum(['asc', 'desc']).default('desc')
});

const taskRunIdParamsSchema = z.object({
  id: z.string().min(1)
});

const taskRunAfterActionReportQuerySchema = z.object({
  stored: z.enum(['true', 'false']).optional()
}).passthrough();

const taskRunOutcomesBatchBodySchema = z.object({
  items: z.array(z.record(z.any())).min(1)
});

const reliabilityCommonQuerySchema = z.object({
  bucket: z.enum(['day', 'week']).optional(),
  window_days: z.coerce.number().int().min(1).max(3650).optional(),
  period_days: z.coerce.number().int().min(1).max(3650).optional(),
  period_a_from: z.string().min(1).optional(),
  period_a_to: z.string().min(1).optional(),
  period_b_from: z.string().min(1).optional(),
  period_b_to: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  week_of: z.string().min(1).optional()
}).passthrough();

const reviewAcknowledgeBodySchema = z.object({
  period_from: z.string().min(1),
  period_to: z.string().min(1),
  reviewer: z.string().min(1),
  notes: z.string().optional(),
  runner: z.string().optional()
});

const reviewAcknowledgementsQuerySchema = z.object({
  period_from: z.string().min(1).optional(),
  period_to: z.string().min(1).optional(),
  runner: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const eventBodySchema = z.object({}).passthrough();

const eventBatchBodySchema = z.array(eventBodySchema);

const benchmarkIdParamsSchema = z.object({
  id: z.string().min(1)
});

const benchmarkRunCaseParamsSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1)
});

const benchmarkCreateBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  status: z.string().optional(),
  task_definition_source: z.string().optional(),
  scoring_spec: z.unknown().optional(),
  policy_spec: z.unknown().optional(),
  owner: z.string().optional()
}).passthrough();

const benchmarkCaseCreateBodySchema = z.object({
  case_key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().optional(),
  fixture_ref: z.string().optional(),
  timeout_seconds: z.coerce.number().int().min(0).optional(),
  allowed_tools: z.unknown().optional(),
  expected_outputs: z.unknown().optional(),
  forbidden_actions: z.unknown().optional(),
  scoring_rules: z.unknown().optional(),
  metadata: z.unknown().optional()
}).passthrough();

const benchmarkRunCreateBodySchema = z.object({
  status: z.string().optional(),
  agent_config: z.unknown().optional(),
  environment_fingerprint: z.string().optional(),
  git_revision: z.string().optional(),
  case_ids: z.array(z.union([z.string(), z.number()])).optional()
}).passthrough();

const benchmarkRunResultBodySchema = z.object({
  task_run_id: z.union([z.string(), z.number(), z.null()]).optional(),
  outcome_id: z.union([z.string(), z.number(), z.null()]).optional(),
  status: z.string().optional(),
  score: z.union([z.coerce.number(), z.null()]).optional(),
  notes: z.union([z.string(), z.null()]).optional(),
  metadata: z.unknown().optional()
}).passthrough();

const entriesQuerySchema = paginationQuerySchema.extend({
  kind: z.string().optional(),
  type: z.string().optional(),
  tool: z.string().optional(),
  subagent: z.string().optional(),
  rootSession: z.string().optional(),
  tag: z.string().optional(),
  query: z.string().optional(),
  sortKey: z.enum(['ts', 'kind', 'tool', 'durationMs']).default('ts'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  runner: z.string().optional(),
  event: z.string().optional(),
  attempt: z.string().optional()
}).passthrough();

const analysisIdParamsSchema = z.object({
  id: z.string().min(1)
});

const analysesCreateBodySchema = z.object({
  model: z.string().optional(),
  event_count: z.coerce.number().int().min(0).optional(),
  event_keys: z.array(z.string()).optional(),
  analysis: z.string().min(1),
  prompt: z.union([z.string(), z.null()]).optional()
}).passthrough();

const analyzeBodySchema = z.object({
  keys: z.array(z.string().min(1)).min(1),
  model: z.string().optional(),
  apiKey: z.string().min(1),
  prompt: z.string().optional()
}).passthrough();

const selectionBodySchema = z.object({
  keys: z.array(z.string().min(1)).min(1)
}).passthrough();

const tagMutationBodySchema = z.object({
  entryKey: z.string().min(1),
  tag: z.string().min(1),
  action: z.enum(['add', 'remove'])
}).passthrough();

const noteMutationBodySchema = z.object({
  entryKey: z.string().min(1),
  note: z.union([z.string(), z.null()]).optional()
}).passthrough();

const importBodySchema = z.object({
  tagsByKey: z.record(z.array(z.string())).optional(),
  notesByKey: z.record(z.string()).optional()
}).passthrough();

module.exports = {
  parseOrRespond,
  taskRunListQuerySchema,
  taskRunIdParamsSchema,
  taskRunAfterActionReportQuerySchema,
  taskRunOutcomesBatchBodySchema,
  reliabilityCommonQuerySchema,
  reviewAcknowledgeBodySchema,
  reviewAcknowledgementsQuerySchema,
  eventBodySchema,
  eventBatchBodySchema,
  benchmarkIdParamsSchema,
  benchmarkRunCaseParamsSchema,
  benchmarkCreateBodySchema,
  benchmarkCaseCreateBodySchema,
  benchmarkRunCreateBodySchema,
  benchmarkRunResultBodySchema,
  entriesQuerySchema,
  analysisIdParamsSchema,
  analysesCreateBodySchema,
  analyzeBodySchema,
  selectionBodySchema,
  tagMutationBodySchema,
  noteMutationBodySchema,
  importBodySchema
};
