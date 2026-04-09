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

module.exports = {
  parseOrRespond,
  taskRunListQuerySchema,
  taskRunIdParamsSchema,
  taskRunAfterActionReportQuerySchema,
  taskRunOutcomesBatchBodySchema,
  reliabilityCommonQuerySchema,
  reviewAcknowledgeBodySchema,
  reviewAcknowledgementsQuerySchema
};
