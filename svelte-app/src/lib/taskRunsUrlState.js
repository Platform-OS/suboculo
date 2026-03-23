function toDateInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getStringParam(params, key, fallback = "") {
  const value = params.get(key);
  return value == null ? fallback : value;
}

function getEnumParam(params, key, allowed, fallback) {
  const value = params.get(key);
  return value && allowed.includes(value) ? value : fallback;
}

function getBooleanParam(params, key, fallback = false) {
  const value = params.get(key);
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function hydrateTaskRunsStateFromUrl(search, defaults) {
  const params = new URLSearchParams(search);

  return {
    taskRunStatusFilter: getStringParam(params, "tr_status", defaults.taskRunStatusFilter) || "all",
    taskRunRunnerFilter: getStringParam(params, "tr_runner", defaults.taskRunRunnerFilter) || "all",
    taskRunQuery: getStringParam(params, "tr_query", defaults.taskRunQuery),
    taskRunCanonicalOutcomeFilter: getStringParam(params, "tr_canonical_outcome", defaults.taskRunCanonicalOutcomeFilter) || "all",
    taskRunFailureModeFilter: getStringParam(params, "tr_failure_mode", defaults.taskRunFailureModeFilter) || "all",
    taskRunFailureSubtypeFilter: getStringParam(params, "tr_failure_subtype", defaults.taskRunFailureSubtypeFilter) || "all",
    taskRunHumanInterventionFilter: getStringParam(params, "tr_human_intervention", defaults.taskRunHumanInterventionFilter) || "all",
    taskRunNeedsLabelingOnly: getBooleanParam(params, "tr_needs_labeling", defaults.taskRunNeedsLabelingOnly),
    reliabilityKpiCompareMode: getEnumParam(params, "cmp_mode", ["preset", "custom"], defaults.reliabilityKpiCompareMode),
    reliabilityKpiComparePreset: getEnumParam(params, "cmp_preset", ["7", "14", "30"], defaults.reliabilityKpiComparePreset),
    reliabilityKpiComparePeriodAFrom: toDateInputValue(getStringParam(params, "cmp_a_from")),
    reliabilityKpiComparePeriodATo: toDateInputValue(getStringParam(params, "cmp_a_to")),
    reliabilityKpiComparePeriodBFrom: toDateInputValue(getStringParam(params, "cmp_b_from")),
    reliabilityKpiComparePeriodBTo: toDateInputValue(getStringParam(params, "cmp_b_to"))
  };
}

export function buildTaskRunsUrl(search, pathname, hash, state) {
  const params = new URLSearchParams(search);

  const setOrDelete = (key, value, shouldPersist = Boolean(value)) => {
    if (shouldPersist) params.set(key, String(value));
    else params.delete(key);
  };

  setOrDelete("tr_source", "derived_attempt", true);
  setOrDelete("tab", "task-runs", true);
  setOrDelete("tr_status", state.taskRunStatusFilter, state.taskRunStatusFilter !== "all");
  setOrDelete("tr_runner", state.taskRunRunnerFilter, state.taskRunRunnerFilter !== "all");
  setOrDelete("tr_query", state.taskRunQuery, !!state.taskRunQuery);
  setOrDelete("tr_canonical_outcome", state.taskRunCanonicalOutcomeFilter, state.taskRunCanonicalOutcomeFilter !== "all");
  setOrDelete("tr_failure_mode", state.taskRunFailureModeFilter, state.taskRunFailureModeFilter !== "all");
  setOrDelete("tr_failure_subtype", state.taskRunFailureSubtypeFilter, state.taskRunFailureSubtypeFilter !== "all");
  setOrDelete("tr_human_intervention", state.taskRunHumanInterventionFilter, state.taskRunHumanInterventionFilter !== "all");
  setOrDelete("tr_needs_labeling", state.taskRunNeedsLabelingOnly, state.taskRunNeedsLabelingOnly);
  setOrDelete("cmp_mode", state.reliabilityKpiCompareMode, state.reliabilityKpiCompareMode !== "preset");
  setOrDelete("cmp_preset", state.reliabilityKpiComparePreset, state.reliabilityKpiCompareMode === "preset");
  setOrDelete("cmp_a_from", state.reliabilityKpiComparePeriodAFrom, state.reliabilityKpiCompareMode === "custom" && !!state.reliabilityKpiComparePeriodAFrom);
  setOrDelete("cmp_a_to", state.reliabilityKpiComparePeriodATo, state.reliabilityKpiCompareMode === "custom" && !!state.reliabilityKpiComparePeriodATo);
  setOrDelete("cmp_b_from", state.reliabilityKpiComparePeriodBFrom, state.reliabilityKpiCompareMode === "custom" && !!state.reliabilityKpiComparePeriodBFrom);
  setOrDelete("cmp_b_to", state.reliabilityKpiComparePeriodBTo, state.reliabilityKpiCompareMode === "custom" && !!state.reliabilityKpiComparePeriodBTo);

  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash || ""}`;
}
