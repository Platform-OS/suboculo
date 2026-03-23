function toTitle(value) {
  return String(value).replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function toOptions(values) {
  return values.map((value) => ({ value, label: toTitle(value) }));
}

export function deriveTaskRunsUiOptions({
  facets,
  outcomeTaxonomy,
  fallbackEvaluationTypes,
  fallbackOutcomeLabels,
  fallbackFailureTaxonomy,
  fallbackFailureModes,
  fallbackRequiredFailureLabels,
  taskRunOutcome,
  taskRunFailureModeFilter
}) {
  const taskRunStatusOptions = [
    { value: "all", label: "All statuses" },
    { value: "running", label: "Running" },
    { value: "completed", label: "Completed" },
    { value: "failed", label: "Failed" },
    { value: "cancelled", label: "Cancelled" },
    { value: "timed_out", label: "Timed out" }
  ];

  const taskRunRunnerOptions = [
    { value: "all", label: "All runners" },
    ...(facets?.runners || []).map((runner) => ({ value: runner, label: runner }))
  ];

  const evaluationTypes = outcomeTaxonomy?.evaluation_types || fallbackEvaluationTypes;
  const outcomeLabels = outcomeTaxonomy?.outcome_labels || fallbackOutcomeLabels;
  const failureTaxonomy = outcomeTaxonomy?.failure_taxonomy || fallbackFailureTaxonomy;
  const failureModes = outcomeTaxonomy?.failure_modes || fallbackFailureModes;
  const requiredFailureLabels = outcomeTaxonomy?.requires_failure_mode_for || fallbackRequiredFailureLabels;

  const requiresFailureMode = requiredFailureLabels.includes(taskRunOutcome?.outcome_label);
  const shouldShowFailureFields =
    requiresFailureMode || !!taskRunOutcome?.failure_mode || !!taskRunOutcome?.failure_subtype;

  const selectedFailureSubtypes = taskRunOutcome?.failure_mode
    ? (failureTaxonomy[taskRunOutcome.failure_mode] || [])
    : [];

  const taskRunFailureSubtypeValues = taskRunFailureModeFilter !== "all"
    ? (failureTaxonomy[taskRunFailureModeFilter] || [])
    : [...new Set(Object.values(failureTaxonomy).flat())].sort();

  return {
    taskRunStatusOptions,
    taskRunRunnerOptions,
    evaluationTypes,
    outcomeLabels,
    failureTaxonomy,
    failureModes,
    requiredFailureLabels,
    requiresFailureMode,
    shouldShowFailureFields,
    selectedFailureSubtypes,
    outcomeLabelOptions: toOptions(outcomeLabels),
    evaluationTypeOptions: toOptions(evaluationTypes),
    failureModeOptions: [{ value: "", label: "Select failure mode" }, ...toOptions(failureModes)],
    failureSubtypeOptions: [{ value: "", label: "Select failure subtype" }, ...toOptions(selectedFailureSubtypes)],
    taskRunCanonicalOutcomeOptions: [
      { value: "all", label: "All canonical outcomes" },
      { value: "none", label: "No canonical outcome" },
      ...toOptions(outcomeLabels)
    ],
    taskRunFailureModeOptions: [
      { value: "all", label: "All failure modes" },
      ...toOptions(failureModes)
    ],
    taskRunFailureSubtypeValues,
    taskRunFailureSubtypeOptions: [
      { value: "all", label: "All failure subtypes" },
      ...toOptions(taskRunFailureSubtypeValues)
    ],
    taskRunHumanInterventionOptions: [
      { value: "all", label: "All human intervention states" },
      { value: "true", label: "Requires human intervention" },
      { value: "false", label: "Does not require intervention" }
    ]
  };
}
