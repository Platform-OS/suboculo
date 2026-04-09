const {
  OUTCOME_LABELS,
  EVALUATION_TYPES,
  FAILURE_TAXONOMY,
  FAILURE_MODES,
  OUTCOME_LABELS_REQUIRING_FAILURE_MODE
} = require('./taxonomy');

function createOutcomesDomain({
  outcomesRepository,
  taskRunsRepository,
  normalizeOptionalString,
  autoLabelEnabled
}) {
  function validateOutcomePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, status: 400, error: 'Outcome payload must be a JSON object' };
    }

    const {
      evaluation_type,
      outcome_label,
      correctness_score,
      safety_score,
      efficiency_score,
      reproducibility_score,
      requires_human_intervention,
      failure_mode,
      failure_subtype,
      notes,
      evaluator,
      evidence,
      is_canonical
    } = payload;

    if (!evaluation_type || !outcome_label) {
      return { ok: false, status: 400, error: 'evaluation_type and outcome_label are required' };
    }
    if (!EVALUATION_TYPES.includes(evaluation_type)) {
      return {
        ok: false,
        status: 400,
        error: 'Invalid evaluation_type',
        allowed: EVALUATION_TYPES
      };
    }
    if (!OUTCOME_LABELS.includes(outcome_label)) {
      return {
        ok: false,
        status: 400,
        error: 'Invalid outcome_label',
        allowed: OUTCOME_LABELS
      };
    }

    const normalizedFailureMode = normalizeOptionalString(failure_mode);
    const normalizedFailureSubtype = normalizeOptionalString(failure_subtype);
    const requiresFailureMode = OUTCOME_LABELS_REQUIRING_FAILURE_MODE.has(outcome_label);

    if (requiresFailureMode && !normalizedFailureMode) {
      return {
        ok: false,
        status: 400,
        error: 'failure_mode is required for this outcome_label',
        outcome_label,
        required_for: [...OUTCOME_LABELS_REQUIRING_FAILURE_MODE]
      };
    }
    if (normalizedFailureMode && !FAILURE_MODES.includes(normalizedFailureMode)) {
      return {
        ok: false,
        status: 400,
        error: 'Invalid failure_mode',
        allowed: FAILURE_MODES
      };
    }
    if (normalizedFailureSubtype && !normalizedFailureMode) {
      return {
        ok: false,
        status: 400,
        error: 'failure_subtype requires failure_mode'
      };
    }
    if (normalizedFailureMode && normalizedFailureSubtype) {
      const allowedSubtypes = FAILURE_TAXONOMY[normalizedFailureMode] || [];
      if (!allowedSubtypes.includes(normalizedFailureSubtype)) {
        return {
          ok: false,
          status: 400,
          error: 'Invalid failure_subtype for failure_mode',
          failure_mode: normalizedFailureMode,
          allowed: allowedSubtypes
        };
      }
    }

    return {
      ok: true,
      value: {
        evaluation_type,
        outcome_label,
        correctness_score: correctness_score ?? null,
        safety_score: safety_score ?? null,
        efficiency_score: efficiency_score ?? null,
        reproducibility_score: reproducibility_score ?? null,
        requires_human_intervention: !!requires_human_intervention,
        failure_mode: normalizedFailureMode,
        failure_subtype: normalizedFailureSubtype,
        notes: notes || null,
        evaluator: evaluator || null,
        evidence: evidence ?? null,
        is_canonical: !!is_canonical
      }
    };
  }

  function insertOutcomeForTaskRun(taskRunId, outcomeInput) {
    taskRunsRepository.clearReportsForTaskRun(taskRunId);
    if (outcomeInput.is_canonical) {
      outcomesRepository.clearCanonicalForTaskRun(taskRunId);
    }
    return outcomesRepository.insertOutcome(taskRunId, outcomeInput, new Date().toISOString());
  }

  function getCanonicalOutcomeForTaskRun(taskRunId) {
    return outcomesRepository.getCanonicalOutcomeHeaderForTaskRun(taskRunId);
  }

  function autoLabelTaskRunIfEligible(taskRunId, summary) {
    if (!autoLabelEnabled) return { applied: false, reason: 'disabled' };
    if (!summary) return { applied: false, reason: 'missing_summary' };

    const existingCanonical = getCanonicalOutcomeForTaskRun(taskRunId);
    if (existingCanonical) {
      return { applied: false, reason: 'canonical_exists', canonical: existingCanonical };
    }

    const eligible = (
      summary.status === 'completed' &&
      Number(summary.errorCount || 0) === 0 &&
      Number(summary.interruptCount || 0) === 0 &&
      Number(summary.totalToolCalls || 0) > 0
    );
    if (!eligible) {
      return { applied: false, reason: 'rule_not_matched' };
    }

    const outcome = {
      evaluation_type: 'rule_based',
      outcome_label: 'success',
      correctness_score: null,
      safety_score: null,
      efficiency_score: null,
      reproducibility_score: null,
      requires_human_intervention: false,
      failure_mode: null,
      failure_subtype: null,
      notes: 'Auto-labeled by conservative rule: completed + no errors + no interrupts.',
      evaluator: 'auto-labeler/v1',
      evidence: {
        rule_id: 'completed_no_errors_no_interrupts_v1',
        status: summary.status,
        error_count: summary.errorCount || 0,
        interrupt_count: summary.interruptCount || 0,
        total_tool_calls: summary.totalToolCalls || 0
      },
      is_canonical: true
    };
    const inserted = insertOutcomeForTaskRun(taskRunId, outcome);
    return { applied: true, outcomeId: inserted.lastInsertRowid, rule_id: outcome.evidence.rule_id };
  }

  return {
    validateOutcomePayload,
    insertOutcomeForTaskRun,
    getCanonicalOutcomeForTaskRun,
    autoLabelTaskRunIfEligible
  };
}

module.exports = {
  createOutcomesDomain
};
