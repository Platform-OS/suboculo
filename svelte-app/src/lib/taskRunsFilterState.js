export function toggleNoCanonicalFilterState(state) {
  const nextCanonical = state.taskRunCanonicalOutcomeFilter === "none" ? "all" : "none";
  if (nextCanonical === "none") {
    return {
      taskRunCanonicalOutcomeFilter: nextCanonical,
      taskRunFailureModeFilter: "all",
      taskRunFailureSubtypeFilter: "all",
      taskRunHumanInterventionFilter: "all"
    };
  }
  return { taskRunCanonicalOutcomeFilter: nextCanonical };
}

export function toggleRequiresHumanFilterState(state) {
  const nextHuman = state.taskRunHumanInterventionFilter === "true" ? "all" : "true";
  const next = { taskRunHumanInterventionFilter: nextHuman };
  if (nextHuman === "true" && state.taskRunCanonicalOutcomeFilter === "none") {
    next.taskRunCanonicalOutcomeFilter = "all";
  }
  return next;
}

export function normalizeTaskRunFailureSubtypeFilterState(state, failureTaxonomy) {
  const values = state.taskRunFailureModeFilter !== "all"
    ? (failureTaxonomy[state.taskRunFailureModeFilter] || [])
    : [...new Set(Object.values(failureTaxonomy).flat())];

  if (state.taskRunFailureSubtypeFilter !== "all" && !values.includes(state.taskRunFailureSubtypeFilter)) {
    return { taskRunFailureSubtypeFilter: "all" };
  }
  return null;
}

export function handleTaskRunCanonicalOutcomeFilterChangeState(state) {
  if (state.taskRunCanonicalOutcomeFilter === "none") {
    return {
      taskRunFailureModeFilter: "all",
      taskRunFailureSubtypeFilter: "all",
      taskRunHumanInterventionFilter: "all"
    };
  }
  return null;
}

export function handleTaskRunFailureModeFilterChangeState(state, failureTaxonomy) {
  const next = {};
  if (state.taskRunFailureModeFilter !== "all" && state.taskRunCanonicalOutcomeFilter === "none") {
    next.taskRunCanonicalOutcomeFilter = "all";
  }

  const normalized = normalizeTaskRunFailureSubtypeFilterState(state, failureTaxonomy);
  if (normalized) Object.assign(next, normalized);
  return Object.keys(next).length ? next : null;
}

export function handleTaskRunHumanInterventionFilterChangeState(state) {
  if (state.taskRunHumanInterventionFilter !== "all" && state.taskRunCanonicalOutcomeFilter === "none") {
    return { taskRunCanonicalOutcomeFilter: "all" };
  }
  return null;
}

export function toggleNeedsLabelingQueueState(state) {
  const nextNeedsLabeling = !state.taskRunNeedsLabelingOnly;
  if (nextNeedsLabeling) {
    return {
      taskRunNeedsLabelingOnly: true,
      taskRunCanonicalOutcomeFilter: "all",
      taskRunFailureModeFilter: "all",
      taskRunFailureSubtypeFilter: "all",
      taskRunHumanInterventionFilter: "all"
    };
  }
  return { taskRunNeedsLabelingOnly: false };
}

export function openNeedsLabelingQueueState() {
  return {
    taskRunNeedsLabelingOnly: true,
    taskRunCanonicalOutcomeFilter: "all",
    taskRunFailureModeFilter: "all",
    taskRunFailureSubtypeFilter: "all",
    taskRunHumanInterventionFilter: "all"
  };
}

export function clearFailureFieldsIfOutcomeNotRequired(outcome, requiredFailureLabels) {
  if (requiredFailureLabels.includes(outcome.outcome_label)) return outcome;
  return { ...outcome, failure_mode: "", failure_subtype: "" };
}

export function normalizeFailureSubtypeForOutcome(outcome, taxonomy) {
  const allowedSubtypes = outcome.failure_mode ? (taxonomy[outcome.failure_mode] || []) : [];
  if (allowedSubtypes.includes(outcome.failure_subtype)) return outcome;
  return { ...outcome, failure_subtype: "" };
}
