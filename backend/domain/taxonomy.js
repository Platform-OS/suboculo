const OUTCOME_LABELS = [
  'success',
  'partial_success',
  'failure',
  'unsafe_success',
  'interrupted',
  'abandoned',
  'unknown'
];

const EVALUATION_TYPES = [
  'human',
  'rule_based',
  'llm_judge',
  'benchmark_checker'
];

const FAILURE_TAXONOMY = {
  planning_failure: [
    'missing_plan',
    'wrong_plan',
    'incomplete_plan'
  ],
  execution_failure: [
    'wrong_edit',
    'incomplete_edit',
    'regression_introduced'
  ],
  tooling_failure: [
    'tool_error',
    'tool_unavailable',
    'tool_timeout'
  ],
  environment_failure: [
    'dependency_missing',
    'sandbox_restriction',
    'external_service_unavailable'
  ],
  safety_violation: [
    'policy_violation',
    'unsafe_command',
    'sensitive_data_exposure'
  ],
  validation_failure: [
    'tests_failed',
    'lint_failed',
    'manual_check_failed'
  ],
  interruption: [
    'user_interrupt',
    'process_killed',
    'context_limit'
  ],
  abandonment: [
    'gave_up',
    'no_progress',
    'deferred_without_resolution'
  ],
  unknown_failure: [
    'insufficient_evidence'
  ]
};

const FAILURE_MODES = Object.keys(FAILURE_TAXONOMY);

const OUTCOME_LABELS_REQUIRING_FAILURE_MODE = new Set([
  'failure',
  'unsafe_success',
  'interrupted',
  'abandoned'
]);

const KPI_MIN_CANONICAL_SAMPLE = 5;
const KPI_MIN_SUCCESS_SAMPLE_FOR_COST = 3;
const TASK_RUN_REPORT_VERSION = '1';
const ATTEMPT_IDLE_GAP_MS = 45 * 60 * 1000;

const KPI_TARGET_METRICS = new Set([
  'success_rate',
  'first_pass_rate',
  'retry_rate',
  'unsafe_success_rate',
  'intervention_rate',
  'cost_per_success'
]);

const DEFAULT_KPI_TARGETS = {
  success_rate: { min: 0.85, severity: 'high' },
  retry_rate: { max: 0.2, severity: 'medium' }
};

module.exports = {
  OUTCOME_LABELS,
  EVALUATION_TYPES,
  FAILURE_TAXONOMY,
  FAILURE_MODES,
  OUTCOME_LABELS_REQUIRING_FAILURE_MODE,
  KPI_MIN_CANONICAL_SAMPLE,
  KPI_MIN_SUCCESS_SAMPLE_FOR_COST,
  TASK_RUN_REPORT_VERSION,
  ATTEMPT_IDLE_GAP_MS,
  KPI_TARGET_METRICS,
  DEFAULT_KPI_TARGETS
};
