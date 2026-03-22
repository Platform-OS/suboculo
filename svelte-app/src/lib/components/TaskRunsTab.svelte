<script>
  import { onDestroy, onMount } from "svelte";
  import * as api from "$lib/api.js";
  import Card from "./ui/Card.svelte";
  import CardContent from "./ui/CardContent.svelte";
  import Button from "./ui/Button.svelte";
  import Input from "./ui/Input.svelte";
  import Label from "./ui/Label.svelte";
  import Select from "./ui/Select.svelte";
  import Badge from "./ui/Badge.svelte";
  import Separator from "./ui/Separator.svelte";
  import Textarea from "./ui/Textarea.svelte";
  import { X } from "lucide-svelte";
  import KpiComparePanel from "./KpiComparePanel.svelte";
  import ReliabilityReviewPanel from "./ReliabilityReviewPanel.svelte";
  import KpiSummaryPanel from "./KpiSummaryPanel.svelte";
  import {
    formatTs,
    formatPercent,
    formatMoney,
    formatSignedPercentDelta
  } from "$lib/formatters.js";

  export let facets = { runners: [] };
  export let outcomeTaxonomy = null;
  export let kpiDefinitions = null;
  export let showNotice = () => {};
  export let onOpenTaskRun = () => {};
  export let onTaskRunsTotalChange = () => {};

  // Task Runs state
  let taskRuns = [];
  let selectedTaskRun = null;
  let loadingTaskRuns = false;
  let taskRunsTotal = 0;
  let taskRunOutcomeSummary = null;
  let reliabilityKpis = null;
  let reliabilityKpisByRunner = null;
  let reliabilityTrends = null;
  let reliabilityTrendInsights = null;
  let reliabilityFailureModeTrends = null;
  let taskRunAfterActionReport = null;
  let taskRunAfterActionReportCache = new Map();
  let loadingTaskRunAfterActionReport = false;
  let reliabilityTrendBucket = "day";
  let reliabilityTrendWindowDays = "30";
  let reliabilityKpiComparePreset = "7";
  let reliabilityKpiCompareMode = "preset";
  let reliabilityKpiComparePeriodAFrom = "";
  let reliabilityKpiComparePeriodATo = "";
  let reliabilityKpiComparePeriodBFrom = "";
  let reliabilityKpiComparePeriodBTo = "";
  let hasHydratedStateFromUrl = false;
  let taskRunsRefreshKey = 0;
  let taskRunFiltersSignal = {};
  let taskRunStatusFilter = "all";
  let taskRunRunnerFilter = "all";
  let taskRunQuery = "";
  let taskRunCanonicalOutcomeFilter = "all";
  let taskRunFailureModeFilter = "all";
  let taskRunFailureSubtypeFilter = "all";
  let taskRunHumanInterventionFilter = "all";
  let taskRunNeedsLabelingOnly = false;
  let selectedTaskRunIds = new Set();
  let savingBulkOutcomes = false;
  let taskRunsLoadTimer;

  const fallbackEvaluationTypes = ["human", "rule_based", "llm_judge", "benchmark_checker"];
  const fallbackOutcomeLabels = ["success", "partial_success", "failure", "unsafe_success", "interrupted", "abandoned", "unknown"];
  const fallbackFailureTaxonomy = {
    planning_failure: ["missing_plan", "wrong_plan", "incomplete_plan"],
    execution_failure: ["wrong_edit", "incomplete_edit", "regression_introduced"],
    tooling_failure: ["tool_error", "tool_unavailable", "tool_timeout"],
    environment_failure: ["dependency_missing", "sandbox_restriction", "external_service_unavailable"],
    safety_violation: ["policy_violation", "unsafe_command", "sensitive_data_exposure"],
    validation_failure: ["tests_failed", "lint_failed", "manual_check_failed"],
    interruption: ["user_interrupt", "process_killed", "context_limit"],
    abandonment: ["gave_up", "no_progress", "deferred_without_resolution"],
    unknown_failure: ["insufficient_evidence"]
  };
  const fallbackFailureModes = Object.keys(fallbackFailureTaxonomy);
  const fallbackRequiredFailureLabels = ["failure", "unsafe_success", "interrupted", "abandoned"];
  const reliabilityTrendBucketOptions = [
    { value: "day", label: "Daily" },
    { value: "week", label: "Weekly" }
  ];
  const reliabilityTrendWindowOptions = [
    { value: "14", label: "14 days" },
    { value: "30", label: "30 days" },
    { value: "60", label: "60 days" }
  ];
  function createDefaultOutcomeForm() {
    return {
      evaluation_type: "human",
      outcome_label: "success",
      correctness_score: "",
      safety_score: "",
      efficiency_score: "",
      reproducibility_score: "",
      requires_human_intervention: false,
      failure_mode: "",
      failure_subtype: "",
      notes: "",
      evaluator: "web-ui",
      is_canonical: true
    };
  }
  let taskRunOutcome = createDefaultOutcomeForm();
  let bulkTaskRunOutcome = createDefaultOutcomeForm();

  const outcomeLabelHelp = {
    success: "Task completed to a reasonable engineering standard.",
    partial_success: "Meaningful progress was made, but the task is not complete.",
    failure: "The requested objective was not achieved.",
    unsafe_success: "The result was achieved, but an important safety or policy boundary was crossed.",
    interrupted: "The run stopped before conclusion due to interruption.",
    abandoned: "The run ended without resolution or effectively gave up.",
    unknown: "The evaluator cannot determine the outcome confidently."
  };

  onMount(async () => {
    hydrateStateFromUrl();
    hasHydratedStateFromUrl = true;
    taskRunFiltersSignal = getTaskRunFilters();
    taskRunsRefreshKey += 1;
    await loadTaskRuns(taskRunFiltersSignal);
  });

  onDestroy(() => {
    clearTimeout(taskRunsLoadTimer);
  });

  function scheduleLoadTaskRuns() {
    clearTimeout(taskRunsLoadTimer);
    taskRunsLoadTimer = setTimeout(() => {
      taskRunFiltersSignal = getTaskRunFilters();
      taskRunsRefreshKey += 1;
      loadTaskRuns(taskRunFiltersSignal);
    }, 150);
  }

  function setTaskRunAarCache(taskRunId, report) {
    const nextCache = new Map(taskRunAfterActionReportCache);
    nextCache.set(taskRunId, report);
    taskRunAfterActionReportCache = nextCache;
  }

  function deleteTaskRunAarCache(taskRunId) {
    const nextCache = new Map(taskRunAfterActionReportCache);
    nextCache.delete(taskRunId);
    taskRunAfterActionReportCache = nextCache;
  }

  async function loadTaskRuns(preparedFilters = null) {
    try {
      loadingTaskRuns = true;
      const filters = preparedFilters || getTaskRunFilters();

      const [result, summary, kpis, kpisByRunner, trends, trendInsights, failureModeTrends] = await Promise.all([
        api.getTaskRuns(filters),
        api.getTaskRunOutcomeSummary(filters),
        api.getReliabilityKpis(filters),
        api.getReliabilityKpisByRunner(filters),
        api.getReliabilityTrends({
          ...filters,
          bucket: reliabilityTrendBucket,
          window_days: reliabilityTrendWindowDays
        }),
        api.getReliabilityTrendInsights({
          ...filters,
          bucket: reliabilityTrendBucket,
          window_days: reliabilityTrendWindowDays
        }),
        api.getReliabilityFailureModeTrends({
          ...filters,
          bucket: reliabilityTrendBucket,
          window_days: reliabilityTrendWindowDays
        })
      ]);
      taskRuns = result.taskRuns;
      selectedTaskRunIds = new Set(
        [...selectedTaskRunIds].filter((id) => result.taskRuns.some((run) => run.id === id))
      );
      taskRunsTotal = result.total;
      onTaskRunsTotalChange(taskRunsTotal);
      taskRunOutcomeSummary = summary;
      reliabilityKpis = kpis;
      reliabilityKpisByRunner = kpisByRunner;
      reliabilityTrends = trends;
      reliabilityTrendInsights = trendInsights;
      reliabilityFailureModeTrends = failureModeTrends;

      if (selectedTaskRun?.id) {
        const updated = result.taskRuns.find(run => run.id === selectedTaskRun.id);
        if (updated) {
          selectedTaskRun = await api.getTaskRun(updated.id);
        }
      }
    } catch (err) {
      console.error('Failed to load task runs:', err);
      taskRunOutcomeSummary = null;
      reliabilityKpis = null;
      reliabilityKpisByRunner = null;
      reliabilityTrends = null;
      reliabilityTrendInsights = null;
      reliabilityFailureModeTrends = null;
    } finally {
      loadingTaskRuns = false;
    }
  }

  function getTaskRunFilters() {
    return {
      pageSize: 100,
      source: "derived_attempt",
      status: taskRunStatusFilter !== "all" ? taskRunStatusFilter : undefined,
      runner: taskRunRunnerFilter !== "all" ? taskRunRunnerFilter : undefined,
      query: taskRunQuery || undefined,
      canonical_outcome_label: taskRunCanonicalOutcomeFilter !== "all" ? taskRunCanonicalOutcomeFilter : undefined,
      has_canonical_outcome: taskRunNeedsLabelingOnly ? "false" : undefined,
      failure_mode: taskRunFailureModeFilter !== "all" ? taskRunFailureModeFilter : undefined,
      failure_subtype: taskRunFailureSubtypeFilter !== "all" ? taskRunFailureSubtypeFilter : undefined,
      requires_human_intervention: taskRunHumanInterventionFilter === "all" ? undefined : taskRunHumanInterventionFilter
    };
  }

  function toggleNoCanonicalFilter() {
    taskRunCanonicalOutcomeFilter = taskRunCanonicalOutcomeFilter === "none" ? "all" : "none";
    if (taskRunCanonicalOutcomeFilter === "none") {
      taskRunFailureModeFilter = "all";
      taskRunFailureSubtypeFilter = "all";
      taskRunHumanInterventionFilter = "all";
    }
  }

  function toggleRequiresHumanFilter() {
    taskRunHumanInterventionFilter = taskRunHumanInterventionFilter === "true" ? "all" : "true";
    if (taskRunHumanInterventionFilter === "true" && taskRunCanonicalOutcomeFilter === "none") {
      taskRunCanonicalOutcomeFilter = "all";
    }
  }

  function normalizeTaskRunFailureSubtypeFilter() {
    const values = taskRunFailureModeFilter !== "all"
      ? (failureTaxonomy[taskRunFailureModeFilter] || [])
      : [...new Set(Object.values(failureTaxonomy).flat())];
    if (taskRunFailureSubtypeFilter !== "all" && !values.includes(taskRunFailureSubtypeFilter)) {
      taskRunFailureSubtypeFilter = "all";
    }
  }

  function handleTaskRunCanonicalOutcomeFilterChange() {
    if (taskRunCanonicalOutcomeFilter === "none") {
      taskRunFailureModeFilter = "all";
      taskRunFailureSubtypeFilter = "all";
      taskRunHumanInterventionFilter = "all";
    }
  }

  function handleTaskRunFailureModeFilterChange() {
    if (taskRunFailureModeFilter !== "all" && taskRunCanonicalOutcomeFilter === "none") {
      taskRunCanonicalOutcomeFilter = "all";
    }
    normalizeTaskRunFailureSubtypeFilter();
  }

  function handleTaskRunHumanInterventionFilterChange() {
    if (taskRunHumanInterventionFilter !== "all" && taskRunCanonicalOutcomeFilter === "none") {
      taskRunCanonicalOutcomeFilter = "all";
    }
  }

  function toggleNeedsLabelingQueue() {
    taskRunNeedsLabelingOnly = !taskRunNeedsLabelingOnly;
    if (taskRunNeedsLabelingOnly) {
      taskRunCanonicalOutcomeFilter = "all";
      taskRunFailureModeFilter = "all";
      taskRunFailureSubtypeFilter = "all";
      taskRunHumanInterventionFilter = "all";
    }
  }

  function toggleTaskRunSelection(taskRunId) {
    const next = new Set(selectedTaskRunIds);
    if (next.has(taskRunId)) next.delete(taskRunId);
    else next.add(taskRunId);
    selectedTaskRunIds = next;
  }

  function selectAllVisibleTaskRuns() {
    selectedTaskRunIds = new Set(taskRuns.map((run) => run.id));
  }

  function clearSelectedTaskRuns() {
    selectedTaskRunIds = new Set();
  }

  function handleBulkOutcomeLabelChange() {
    const requiredFailureLabels = outcomeTaxonomy?.requires_failure_mode_for || fallbackRequiredFailureLabels;
    if (!requiredFailureLabels.includes(bulkTaskRunOutcome.outcome_label)) {
      bulkTaskRunOutcome = { ...bulkTaskRunOutcome, failure_mode: "", failure_subtype: "" };
    }
  }

  function handleBulkFailureModeChange() {
    const taxonomy = outcomeTaxonomy?.failure_taxonomy || fallbackFailureTaxonomy;
    const allowedSubtypes = bulkTaskRunOutcome.failure_mode
      ? (taxonomy[bulkTaskRunOutcome.failure_mode] || [])
      : [];
    if (!allowedSubtypes.includes(bulkTaskRunOutcome.failure_subtype)) {
      bulkTaskRunOutcome = { ...bulkTaskRunOutcome, failure_subtype: "" };
    }
  }

  async function applyBulkTaskRunOutcome() {
    if (selectedTaskRunIds.size === 0) {
      alert("Select at least one task run.");
      return;
    }

    const requiredFailureLabels = outcomeTaxonomy?.requires_failure_mode_for || fallbackRequiredFailureLabels;
    const requiresFailure = requiredFailureLabels.includes(bulkTaskRunOutcome.outcome_label);
    if (requiresFailure && !bulkTaskRunOutcome.failure_mode) {
      alert("Failure mode is required for this outcome label.");
      return;
    }

    try {
      savingBulkOutcomes = true;
      const items = [...selectedTaskRunIds].map((taskRunId) => ({
        task_run_id: taskRunId,
        evaluation_type: bulkTaskRunOutcome.evaluation_type,
        outcome_label: bulkTaskRunOutcome.outcome_label,
        correctness_score: bulkTaskRunOutcome.correctness_score === "" ? null : Number(bulkTaskRunOutcome.correctness_score),
        safety_score: bulkTaskRunOutcome.safety_score === "" ? null : Number(bulkTaskRunOutcome.safety_score),
        efficiency_score: bulkTaskRunOutcome.efficiency_score === "" ? null : Number(bulkTaskRunOutcome.efficiency_score),
        reproducibility_score: bulkTaskRunOutcome.reproducibility_score === "" ? null : Number(bulkTaskRunOutcome.reproducibility_score),
        requires_human_intervention: bulkTaskRunOutcome.requires_human_intervention,
        failure_mode: bulkTaskRunOutcome.failure_mode || undefined,
        failure_subtype: bulkTaskRunOutcome.failure_subtype || undefined,
        notes: bulkTaskRunOutcome.notes || undefined,
        evaluator: bulkTaskRunOutcome.evaluator || undefined,
        is_canonical: bulkTaskRunOutcome.is_canonical
      }));

      const result = await api.createOutcomesBatch(items);
      showNotice(
        `Bulk outcomes: ${result.success_count} succeeded, ${result.failure_count} failed.`,
        result.failure_count > 0 ? "error" : "success"
      );

      await loadTaskRuns();
      if (selectedTaskRun?.id && selectedTaskRunIds.has(selectedTaskRun.id)) {
        selectedTaskRun = await api.getTaskRun(selectedTaskRun.id);
      }
      if (result.failure_count === 0) {
        clearSelectedTaskRuns();
      }
    } catch (err) {
      console.error("Failed to apply bulk outcomes:", err);
      alert("Failed to apply bulk outcomes");
    } finally {
      savingBulkOutcomes = false;
    }
  }

  async function deriveTaskRunsNow() {
    try {
      loadingTaskRuns = true;
      await api.deriveTaskRuns();
      await loadTaskRuns();
    } catch (err) {
      console.error('Failed to derive task runs:', err);
      alert('Failed to derive task runs');
    } finally {
      loadingTaskRuns = false;
    }
  }

  async function viewTaskRun(id) {
    try {
      selectedTaskRun = await api.getTaskRun(id);
      onOpenTaskRun(id);
      const cached = taskRunAfterActionReportCache.get(id) || null;
      taskRunAfterActionReport = cached;
      if (!cached) {
        try {
          const persisted = await api.getTaskRunAfterActionReport(id);
          taskRunAfterActionReport = persisted;
          setTaskRunAarCache(id, persisted);
        } catch (reportErr) {
          console.warn("Failed to load persisted after-action report:", reportErr);
          taskRunAfterActionReport = null;
        }
      }
    } catch (err) {
      console.error('Failed to load task run:', err);
      alert('Failed to load task run');
    }
  }

  async function generateTaskRunAfterActionReport() {
    if (!selectedTaskRun?.id) return;
    try {
      loadingTaskRunAfterActionReport = true;
      const report = await api.getTaskRunAfterActionReport(selectedTaskRun.id);
      taskRunAfterActionReport = report;
      setTaskRunAarCache(selectedTaskRun.id, report);
    } catch (err) {
      console.error('Failed to generate after-action report:', err);
      alert('Failed to generate after-action report');
    } finally {
      loadingTaskRunAfterActionReport = false;
    }
  }

  async function copyTaskRunAfterActionReportMarkdown() {
    if (!taskRunAfterActionReport?.markdown) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(taskRunAfterActionReport.markdown);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = taskRunAfterActionReport.markdown;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      showNotice('After-action report copied to clipboard', 'success');
    } catch (err) {
      console.error('Failed to copy after-action report:', err);
      showNotice('Failed to copy after-action report', 'error');
    }
  }

  function openNeedsLabelingQueue() {
    taskRunNeedsLabelingOnly = true;
    taskRunCanonicalOutcomeFilter = "all";
    taskRunFailureModeFilter = "all";
    taskRunFailureSubtypeFilter = "all";
    taskRunHumanInterventionFilter = "all";
  }

  function resetOutcomeForm() {
    taskRunOutcome = createDefaultOutcomeForm();
  }

  function handleOutcomeLabelChange() {
    const requiredFailureLabels = outcomeTaxonomy?.requires_failure_mode_for || fallbackRequiredFailureLabels;
    if (!requiredFailureLabels.includes(taskRunOutcome.outcome_label)) {
      taskRunOutcome = { ...taskRunOutcome, failure_mode: "", failure_subtype: "" };
    }
  }

  function handleFailureModeChange() {
    const taxonomy = outcomeTaxonomy?.failure_taxonomy || fallbackFailureTaxonomy;
    const allowedSubtypes = taskRunOutcome.failure_mode
      ? (taxonomy[taskRunOutcome.failure_mode] || [])
      : [];
    if (!allowedSubtypes.includes(taskRunOutcome.failure_subtype)) {
      taskRunOutcome = { ...taskRunOutcome, failure_subtype: "" };
    }
  }

  async function saveTaskRunOutcome() {
    if (!selectedTaskRun) return;
    if (requiresFailureMode && !taskRunOutcome.failure_mode) {
      alert("Failure mode is required for this outcome label.");
      return;
    }

    try {
      const taskRunId = selectedTaskRun.id;
      await api.createOutcome(selectedTaskRun.id, {
        evaluation_type: taskRunOutcome.evaluation_type,
        outcome_label: taskRunOutcome.outcome_label,
        correctness_score: taskRunOutcome.correctness_score === "" ? null : Number(taskRunOutcome.correctness_score),
        safety_score: taskRunOutcome.safety_score === "" ? null : Number(taskRunOutcome.safety_score),
        efficiency_score: taskRunOutcome.efficiency_score === "" ? null : Number(taskRunOutcome.efficiency_score),
        reproducibility_score: taskRunOutcome.reproducibility_score === "" ? null : Number(taskRunOutcome.reproducibility_score),
        requires_human_intervention: taskRunOutcome.requires_human_intervention,
        failure_mode: taskRunOutcome.failure_mode || undefined,
        failure_subtype: taskRunOutcome.failure_subtype || undefined,
        notes: taskRunOutcome.notes || undefined,
        evaluator: taskRunOutcome.evaluator || undefined,
        is_canonical: taskRunOutcome.is_canonical
      });

      selectedTaskRun = await api.getTaskRun(taskRunId);
      deleteTaskRunAarCache(taskRunId);
      loadingTaskRunAfterActionReport = true;
      try {
        const updatedReport = await api.getTaskRunAfterActionReport(taskRunId);
        taskRunAfterActionReport = updatedReport;
        setTaskRunAarCache(taskRunId, updatedReport);
      } catch (reportErr) {
        console.error('Failed to regenerate after-action report:', reportErr);
        taskRunAfterActionReport = null;
      } finally {
        loadingTaskRunAfterActionReport = false;
      }
      await loadTaskRuns();
      resetOutcomeForm();
    } catch (err) {
      console.error('Failed to save outcome:', err);
      alert(err.message);
    }
  }

  function formatBucketStart(value, bucket = "day") {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    if (bucket === "week") {
      return `Week of ${date.toLocaleDateString()}`;
    }
    return date.toLocaleDateString();
  }

  function formatLabel(value) {
    if (!value) return "";
    return String(value).replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  }

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

  function hydrateStateFromUrl() {
    const params = new URLSearchParams(window.location.search);

    taskRunStatusFilter = getStringParam(params, "tr_status", taskRunStatusFilter) || "all";
    taskRunRunnerFilter = getStringParam(params, "tr_runner", taskRunRunnerFilter) || "all";
    taskRunQuery = getStringParam(params, "tr_query", taskRunQuery);
    taskRunCanonicalOutcomeFilter = getStringParam(params, "tr_canonical_outcome", taskRunCanonicalOutcomeFilter) || "all";
    taskRunFailureModeFilter = getStringParam(params, "tr_failure_mode", taskRunFailureModeFilter) || "all";
    taskRunFailureSubtypeFilter = getStringParam(params, "tr_failure_subtype", taskRunFailureSubtypeFilter) || "all";
    taskRunHumanInterventionFilter = getStringParam(params, "tr_human_intervention", taskRunHumanInterventionFilter) || "all";
    taskRunNeedsLabelingOnly = getBooleanParam(params, "tr_needs_labeling", taskRunNeedsLabelingOnly);

    reliabilityKpiCompareMode = getEnumParam(params, "cmp_mode", ["preset", "custom"], reliabilityKpiCompareMode);
    reliabilityKpiComparePreset = getEnumParam(params, "cmp_preset", ["7", "14", "30"], reliabilityKpiComparePreset);

    reliabilityKpiComparePeriodAFrom = toDateInputValue(getStringParam(params, "cmp_a_from"));
    reliabilityKpiComparePeriodATo = toDateInputValue(getStringParam(params, "cmp_a_to"));
    reliabilityKpiComparePeriodBFrom = toDateInputValue(getStringParam(params, "cmp_b_from"));
    reliabilityKpiComparePeriodBTo = toDateInputValue(getStringParam(params, "cmp_b_to"));
  }

  function syncStateToUrl() {
    const params = new URLSearchParams(window.location.search);

    const setOrDelete = (key, value, shouldPersist = Boolean(value)) => {
      if (shouldPersist) params.set(key, String(value));
      else params.delete(key);
    };

    setOrDelete("tr_source", "derived_attempt", true);
    setOrDelete("tab", "task-runs", true);
    setOrDelete("tr_status", taskRunStatusFilter, taskRunStatusFilter !== "all");
    setOrDelete("tr_runner", taskRunRunnerFilter, taskRunRunnerFilter !== "all");
    setOrDelete("tr_query", taskRunQuery, !!taskRunQuery);
    setOrDelete("tr_canonical_outcome", taskRunCanonicalOutcomeFilter, taskRunCanonicalOutcomeFilter !== "all");
    setOrDelete("tr_failure_mode", taskRunFailureModeFilter, taskRunFailureModeFilter !== "all");
    setOrDelete("tr_failure_subtype", taskRunFailureSubtypeFilter, taskRunFailureSubtypeFilter !== "all");
    setOrDelete("tr_human_intervention", taskRunHumanInterventionFilter, taskRunHumanInterventionFilter !== "all");
    setOrDelete("tr_needs_labeling", taskRunNeedsLabelingOnly, taskRunNeedsLabelingOnly);

    setOrDelete("cmp_mode", reliabilityKpiCompareMode, reliabilityKpiCompareMode !== "preset");
    setOrDelete("cmp_preset", reliabilityKpiComparePreset, reliabilityKpiCompareMode === "preset");
    setOrDelete("cmp_a_from", reliabilityKpiComparePeriodAFrom, reliabilityKpiCompareMode === "custom" && !!reliabilityKpiComparePeriodAFrom);
    setOrDelete("cmp_a_to", reliabilityKpiComparePeriodATo, reliabilityKpiCompareMode === "custom" && !!reliabilityKpiComparePeriodATo);
    setOrDelete("cmp_b_from", reliabilityKpiComparePeriodBFrom, reliabilityKpiCompareMode === "custom" && !!reliabilityKpiComparePeriodBFrom);
    setOrDelete("cmp_b_to", reliabilityKpiComparePeriodBTo, reliabilityKpiCompareMode === "custom" && !!reliabilityKpiComparePeriodBTo);

    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash || ""}`;
    window.history.replaceState({}, "", nextUrl);
  }

  function formatFailureModeRow(bucketRow) {
    if (!bucketRow?.by_mode?.length) return "—";
    return bucketRow.by_mode
      .slice(0, 3)
      .map((modeRow) => `${modeRow.failure_mode} ${modeRow.count} (${formatPercent(modeRow.failure_mode_share)})`)
      .join(", ");
  }

  $: taskRunStatusOptions = [
    { value: "all", label: "All statuses" },
    { value: "running", label: "Running" },
    { value: "completed", label: "Completed" },
    { value: "failed", label: "Failed" },
    { value: "cancelled", label: "Cancelled" },
    { value: "timed_out", label: "Timed out" },
  ];

  $: taskRunRunnerOptions = [
    { value: "all", label: "All runners" },
    ...facets.runners.map((r) => ({ value: r, label: r })),
  ];

  $: evaluationTypes = outcomeTaxonomy?.evaluation_types || fallbackEvaluationTypes;
  $: outcomeLabels = outcomeTaxonomy?.outcome_labels || fallbackOutcomeLabels;
  $: failureTaxonomy = outcomeTaxonomy?.failure_taxonomy || fallbackFailureTaxonomy;
  $: failureModes = outcomeTaxonomy?.failure_modes || fallbackFailureModes;
  $: requiredFailureLabels = outcomeTaxonomy?.requires_failure_mode_for || fallbackRequiredFailureLabels;
  $: requiresFailureMode = requiredFailureLabels.includes(taskRunOutcome.outcome_label);
  $: shouldShowFailureFields = requiresFailureMode || !!taskRunOutcome.failure_mode || !!taskRunOutcome.failure_subtype;
  $: selectedFailureSubtypes = taskRunOutcome.failure_mode
    ? (failureTaxonomy[taskRunOutcome.failure_mode] || [])
    : [];

  $: outcomeLabelOptions = [
    ...outcomeLabels.map((value) => ({
      value,
      label: value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
    }))
  ];

  $: evaluationTypeOptions = [
    ...evaluationTypes.map((value) => ({
      value,
      label: value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
    })),
  ];

  $: failureModeOptions = [
    { value: "", label: "Select failure mode" },
    ...failureModes.map((value) => ({
      value,
      label: value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
    })),
  ];

  $: failureSubtypeOptions = [
    { value: "", label: "Select failure subtype" },
    ...selectedFailureSubtypes.map((value) => ({
      value,
      label: value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
    })),
  ];

  $: taskRunCanonicalOutcomeOptions = [
    { value: "all", label: "All canonical outcomes" },
    { value: "none", label: "No canonical outcome" },
    ...outcomeLabels.map((value) => ({
      value,
      label: value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
    }))
  ];

  $: taskRunFailureModeOptions = [
    { value: "all", label: "All failure modes" },
    ...failureModes.map((value) => ({
      value,
      label: value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
    }))
  ];

  $: taskRunFailureSubtypeValues = taskRunFailureModeFilter !== "all"
    ? (failureTaxonomy[taskRunFailureModeFilter] || [])
    : [...new Set(Object.values(failureTaxonomy).flat())].sort();

  $: taskRunFailureSubtypeOptions = [
    { value: "all", label: "All failure subtypes" },
    ...taskRunFailureSubtypeValues.map((value) => ({
      value,
      label: value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
    }))
  ];

  $: taskRunHumanInterventionOptions = [
    { value: "all", label: "All human intervention states" },
    { value: "true", label: "Requires human intervention" },
    { value: "false", label: "Does not require intervention" }
  ];

  $: if (hasHydratedStateFromUrl && (
    taskRunStatusFilter ||
    taskRunRunnerFilter ||
    taskRunQuery !== undefined ||
    taskRunCanonicalOutcomeFilter ||
    taskRunFailureModeFilter ||
    taskRunFailureSubtypeFilter ||
    taskRunHumanInterventionFilter ||
    taskRunNeedsLabelingOnly ||
    reliabilityKpiComparePreset ||
    reliabilityKpiCompareMode ||
    reliabilityKpiComparePeriodAFrom !== undefined ||
    reliabilityKpiComparePeriodATo !== undefined ||
    reliabilityKpiComparePeriodBFrom !== undefined ||
    reliabilityKpiComparePeriodBTo !== undefined ||
    reliabilityTrendBucket ||
    reliabilityTrendWindowDays
  )) {
    scheduleLoadTaskRuns();
  }

  $: if (hasHydratedStateFromUrl) {
    syncStateToUrl();
  }
</script>

        <Card class="rounded-2xl shadow-sm">
          <CardContent class="p-4 md:p-5 space-y-4">
            <div class="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 class="text-lg font-semibold">Task Runs</h2>
                <div class="text-sm text-muted-foreground">
                  Derived from root sessions and used as the base unit for outcomes and benchmarks.
                </div>
              </div>
              <div class="flex gap-2">
                <Button variant="outline" size="sm" on:click={loadTaskRuns} disabled={loadingTaskRuns}>
                  {loadingTaskRuns ? 'Loading...' : 'Refresh'}
                </Button>
                <Button variant="secondary" size="sm" on:click={deriveTaskRunsNow} disabled={loadingTaskRuns}>
                  Derive from events
                </Button>
              </div>
            </div>

            <Separator />

            <div class="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div class="md:col-span-5 space-y-1">
                <Label>Search</Label>
                <Input bind:value={taskRunQuery} placeholder="Search task key, title, description, root session..." />
              </div>
              <div class="md:col-span-3 space-y-1">
                <Label>Status</Label>
                <Select bind:value={taskRunStatusFilter} options={taskRunStatusOptions} />
              </div>
              <div class="md:col-span-4 space-y-1">
                <Label>Runner</Label>
                <Select bind:value={taskRunRunnerFilter} options={taskRunRunnerOptions} />
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div class="md:col-span-3 space-y-1">
                <Label>Canonical outcome</Label>
                <Select
                  bind:value={taskRunCanonicalOutcomeFilter}
                  options={taskRunCanonicalOutcomeOptions}
                  on:change={handleTaskRunCanonicalOutcomeFilterChange}
                />
              </div>
              <div class="md:col-span-3 space-y-1">
                <Label>Failure mode</Label>
                <Select
                  bind:value={taskRunFailureModeFilter}
                  options={taskRunFailureModeOptions}
                  on:change={handleTaskRunFailureModeFilterChange}
                />
              </div>
              <div class="md:col-span-3 space-y-1">
                <Label>Failure subtype</Label>
                <Select
                  bind:value={taskRunFailureSubtypeFilter}
                  options={taskRunFailureSubtypeOptions}
                  on:change={normalizeTaskRunFailureSubtypeFilter}
                />
              </div>
              <div class="md:col-span-3 space-y-1">
                <Label>Human intervention</Label>
                <Select
                  bind:value={taskRunHumanInterventionFilter}
                  options={taskRunHumanInterventionOptions}
                  on:change={handleTaskRunHumanInterventionFilterChange}
                />
              </div>
            </div>

            <div class="flex gap-2 flex-wrap">
              <Button
                variant={taskRunCanonicalOutcomeFilter === "none" ? "default" : "outline"}
                size="sm"
                on:click={toggleNoCanonicalFilter}
              >
                No canonical outcome
              </Button>
              <Button
                variant={taskRunHumanInterventionFilter === "true" ? "default" : "outline"}
                size="sm"
                on:click={toggleRequiresHumanFilter}
              >
                Requires human intervention
              </Button>
              <Button
                variant={taskRunNeedsLabelingOnly ? "default" : "outline"}
                size="sm"
                on:click={toggleNeedsLabelingQueue}
              >
                Needs labeling queue
              </Button>
            </div>
          </CardContent>
        </Card>

        <ReliabilityReviewPanel
          filters={taskRunFiltersSignal}
          refreshKey={taskRunsRefreshKey}
          trendBucket={reliabilityTrendBucket}
          showNotice={showNotice}
          onOpenTaskRun={viewTaskRun}
          onOpenNeedsLabelingQueue={openNeedsLabelingQueue}
        />

        <KpiComparePanel
          filters={taskRunFiltersSignal}
          refreshKey={taskRunsRefreshKey}
          bind:compareMode={reliabilityKpiCompareMode}
          bind:comparePreset={reliabilityKpiComparePreset}
          bind:periodAFrom={reliabilityKpiComparePeriodAFrom}
          bind:periodATo={reliabilityKpiComparePeriodATo}
          bind:periodBFrom={reliabilityKpiComparePeriodBFrom}
          bind:periodBTo={reliabilityKpiComparePeriodBTo}
          showNotice={showNotice}
        />

        <KpiSummaryPanel
          loading={loadingTaskRuns}
          {kpiDefinitions}
          {reliabilityKpisByRunner}
          {reliabilityKpis}
          {taskRunOutcomeSummary}
        />

        <Card class="rounded-2xl shadow-sm">
          <CardContent class="p-4 md:p-5 space-y-4">
            <div class="flex items-center justify-between gap-3 flex-wrap">
              <div class="text-base font-semibold">Reliability Trends</div>
              <div class="flex gap-2">
                <Select bind:value={reliabilityTrendBucket} options={reliabilityTrendBucketOptions} />
                <Select bind:value={reliabilityTrendWindowDays} options={reliabilityTrendWindowOptions} />
              </div>
            </div>

            {#if reliabilityTrends?.series?.length}
              <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div class="rounded-xl border p-3 space-y-2">
                  <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Improving</div>
                  {#if reliabilityTrendInsights?.insights?.improving?.length}
                    {#each reliabilityTrendInsights.insights.improving as insight (`improve-${insight.metric}-${insight.current_bucket_start}`)}
                      <div class="text-sm flex items-center justify-between gap-3">
                        <span>{formatLabel(insight.metric)}</span>
                        <span class="text-green-700">{formatSignedPercentDelta(insight.abs_delta)}</span>
                      </div>
                    {/each}
                  {:else}
                    <div class="text-xs text-muted-foreground">No significant improving signals.</div>
                  {/if}
                </div>

                <div class="rounded-xl border p-3 space-y-2">
                  <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Degrading</div>
                  {#if reliabilityTrendInsights?.insights?.degrading?.length}
                    {#each reliabilityTrendInsights.insights.degrading as insight (`degrade-${insight.metric}-${insight.current_bucket_start}`)}
                      <div class="text-sm flex items-center justify-between gap-3">
                        <span>{formatLabel(insight.metric)}</span>
                        <span class="text-red-700">{formatSignedPercentDelta(insight.abs_delta)}</span>
                      </div>
                    {/each}
                  {:else}
                    <div class="text-xs text-muted-foreground">No significant degrading signals.</div>
                  {/if}
                </div>

                <div class="rounded-xl border p-3 space-y-2">
                  <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Insufficient Evidence</div>
                  {#if reliabilityTrendInsights?.insights?.insufficient_evidence?.length}
                    {#each reliabilityTrendInsights.insights.insufficient_evidence.slice(-3) as item (`evidence-${item.metric}-${item.bucket_start}`)}
                      <div class="text-xs text-muted-foreground">
                        {formatLabel(item.metric)}: {item.reason}
                      </div>
                    {/each}
                  {:else}
                    <div class="text-xs text-muted-foreground">Sample guardrails satisfied.</div>
                  {/if}
                </div>
              </div>

              <div class="overflow-auto rounded-xl border">
                <table class="min-w-full text-sm">
                  <thead class="bg-muted/20 text-xs text-muted-foreground uppercase tracking-wide">
                    <tr>
                      <th class="px-3 py-2 text-left">Bucket</th>
                      <th class="px-3 py-2 text-right">Runs</th>
                      <th class="px-3 py-2 text-right">Success</th>
                      <th class="px-3 py-2 text-right">Partial</th>
                      <th class="px-3 py-2 text-right">Failure</th>
                      <th class="px-3 py-2 text-right">Retry</th>
                      <th class="px-3 py-2 text-right">Cost/success</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each [...reliabilityTrends.series].reverse() as bucketRow (bucketRow.bucket_start)}
                      <tr class="border-t">
                        <td class="px-3 py-2">{formatBucketStart(bucketRow.bucket_start, reliabilityTrends.bucket)}</td>
                        <td class="px-3 py-2 text-right">{bucketRow.task_runs}</td>
                        <td class="px-3 py-2 text-right">{formatPercent(bucketRow.success_rate)}</td>
                        <td class="px-3 py-2 text-right">{formatPercent(bucketRow.partial_success_rate)}</td>
                        <td class="px-3 py-2 text-right">{formatPercent(bucketRow.failure_rate)}</td>
                        <td class="px-3 py-2 text-right">{formatPercent(bucketRow.retry_rate)}</td>
                        <td class="px-3 py-2 text-right">{formatMoney(bucketRow.cost_per_success)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>

              <div class="rounded-xl border p-3 space-y-2">
                <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Failure Mode Trends</div>
                {#if reliabilityFailureModeTrends?.series?.some((row) => row.with_failure_mode > 0)}
                  <div class="overflow-auto rounded-xl border">
                    <table class="min-w-full text-sm">
                      <thead class="bg-muted/20 text-xs text-muted-foreground uppercase tracking-wide">
                        <tr>
                          <th class="px-3 py-2 text-left">Bucket</th>
                          <th class="px-3 py-2 text-right">Canonical</th>
                          <th class="px-3 py-2 text-right">With failure mode</th>
                          <th class="px-3 py-2 text-left">Top modes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each [...reliabilityFailureModeTrends.series].reverse() as modeBucket (modeBucket.bucket_start)}
                          <tr class="border-t">
                            <td class="px-3 py-2">{formatBucketStart(modeBucket.bucket_start, reliabilityFailureModeTrends.bucket)}</td>
                            <td class="px-3 py-2 text-right">{modeBucket.with_canonical_outcome}</td>
                            <td class="px-3 py-2 text-right">{modeBucket.with_failure_mode}</td>
                            <td class="px-3 py-2">{formatFailureModeRow(modeBucket)}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {:else}
                  <div class="text-xs text-muted-foreground">No failure mode data in current scope.</div>
                {/if}
                {#if reliabilityFailureModeTrends?.insufficient_evidence?.length}
                  <div class="text-xs text-muted-foreground">
                    Guardrail: canonical sample should be at least {reliabilityFailureModeTrends?.thresholds?.min_canonical_sample ?? "—"} per bucket for stable mode trends.
                  </div>
                {/if}
              </div>

              {#if Object.keys(reliabilityTrends.by_runner || {}).length}
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {#each Object.entries(reliabilityTrends.by_runner) as [runnerName, runnerSeries] (runnerName)}
                    <div class="rounded-xl border p-3 space-y-2">
                      <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">{runnerName}</div>
                      {#if runnerSeries.length}
                        {#each [...runnerSeries].slice(-3).reverse() as runnerBucket (runnerBucket.bucket_start)}
                          <div class="flex items-center justify-between text-sm">
                            <span>{formatBucketStart(runnerBucket.bucket_start, reliabilityTrends.bucket)}</span>
                            <span class="text-muted-foreground">{runnerBucket.task_runs} runs · {formatPercent(runnerBucket.success_rate)}</span>
                          </div>
                        {/each}
                      {:else}
                        <div class="text-xs text-muted-foreground">No buckets.</div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            {:else}
              <div class="text-sm text-muted-foreground">
                No trend data in current scope.
              </div>
            {/if}
          </CardContent>
        </Card>

        <div class="grid grid-cols-1 xl:grid-cols-[1fr_520px] gap-4">
          <Card class="rounded-2xl shadow-sm">
            <CardContent class="p-0">
              <div class="flex items-center justify-between p-4 bg-muted/5">
                <div class="text-base font-semibold">Runs</div>
                <div class="text-sm text-muted-foreground">{taskRunsTotal} total</div>
              </div>
              <div class="px-4 py-3 border-b bg-muted/5 space-y-3">
                <div class="flex items-center justify-between gap-2 flex-wrap">
                  <div class="text-xs text-muted-foreground">{selectedTaskRunIds.size} selected</div>
                  <div class="flex gap-2">
                    <Button variant="outline" size="sm" on:click={selectAllVisibleTaskRuns} disabled={taskRuns.length === 0}>Select visible</Button>
                    <Button variant="outline" size="sm" on:click={clearSelectedTaskRuns} disabled={selectedTaskRunIds.size === 0}>Clear</Button>
                  </div>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-12 gap-2">
                  <div class="md:col-span-3">
                    <Select bind:value={bulkTaskRunOutcome.evaluation_type} options={evaluationTypeOptions} />
                  </div>
                  <div class="md:col-span-3">
                    <Select bind:value={bulkTaskRunOutcome.outcome_label} options={outcomeLabelOptions} on:change={handleBulkOutcomeLabelChange} />
                  </div>
                  <div class="md:col-span-3">
                    <Select bind:value={bulkTaskRunOutcome.failure_mode} options={failureModeOptions} on:change={handleBulkFailureModeChange} />
                  </div>
                  <div class="md:col-span-3">
                    <Button class="w-full" size="sm" on:click={applyBulkTaskRunOutcome} disabled={savingBulkOutcomes || selectedTaskRunIds.size === 0}>
                      {savingBulkOutcomes ? "Applying..." : "Apply to selected"}
                    </Button>
                  </div>
                </div>
              </div>
              <Separator />

              {#if loadingTaskRuns}
                <div class="p-6 text-sm text-muted-foreground">Loading task runs...</div>
              {:else if taskRuns.length === 0}
                <div class="p-6 text-sm text-muted-foreground">
                  No task runs yet. Click "Derive from events" to backfill them from existing sessions.
                </div>
              {:else}
                <div class="divide-y">
                  {#each taskRuns as run (run.id)}
                    <button
                      type="button"
                      class="w-full text-left p-4 hover:bg-muted/20 transition-colors {selectedTaskRun?.id === run.id ? 'bg-blue-50' : ''}"
                      on:click={() => viewTaskRun(run.id)}
                    >
                      <div class="flex items-start justify-between gap-4">
                        <div class="space-y-2 min-w-0">
                          <div class="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedTaskRunIds.has(run.id)}
                              on:click|stopPropagation
                              on:change|stopPropagation={() => toggleTaskRunSelection(run.id)}
                              class="w-4 h-4"
                            />
                            <span class="font-medium truncate">{run.title || run.task_key}</span>
                          </div>
                          <div class="text-xs text-muted-foreground font-mono break-all">{run.task_key}</div>
                          <div class="flex flex-wrap gap-2">
                            <Badge variant="outline">{run.runner || 'unknown'}</Badge>
                            <Badge variant="secondary">{run.status}</Badge>
                            <Badge variant="outline">{run.total_events} events</Badge>
                            <Badge variant="outline">{run.total_tool_calls} tools</Badge>
                          </div>
                        </div>
                        <div class="text-right text-xs text-muted-foreground space-y-1 flex-shrink-0">
                          <div>{formatTs(run.started_at)}</div>
                          <div>{run.total_duration_ms || 0}ms tool time</div>
                          {#if run.estimated_cost}
                            <div>${run.estimated_cost.toFixed(4)}</div>
                          {/if}
                        </div>
                      </div>
                    </button>
                  {/each}
                </div>
              {/if}
            </CardContent>
          </Card>

          <Card class="rounded-2xl shadow-sm">
            <CardContent class="p-4 space-y-4">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <div class="text-base font-semibold">Task Run Detail</div>
                  <div class="text-xs text-muted-foreground break-all font-mono mt-1">
                    {selectedTaskRun ? selectedTaskRun.task_key : "Select a task run"}
                  </div>
                </div>
                {#if selectedTaskRun}
                  <Button variant="ghost" on:click={() => { selectedTaskRun = null; taskRunAfterActionReport = null; }} class="h-8 w-8 p-0">
                    <X class="w-4 h-4" />
                  </Button>
                {/if}
              </div>

              {#if selectedTaskRun}
                <div class="space-y-3">
                  <div class="flex flex-wrap gap-2">
                    <Badge variant="outline">{selectedTaskRun.runner || 'unknown'}</Badge>
                    <Badge variant="secondary">{selectedTaskRun.status}</Badge>
                    <Badge variant="outline">{selectedTaskRun.total_events} events</Badge>
                    <Badge variant="outline">{selectedTaskRun.total_tool_calls} tools</Badge>
                    <Badge variant="outline">{selectedTaskRun.distinct_tools} distinct tools</Badge>
                  </div>

                  <div class="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div class="text-muted-foreground">Started</div>
                      <div class="font-medium">{formatTs(selectedTaskRun.started_at)}</div>
                    </div>
                    <div>
                      <div class="text-muted-foreground">Ended</div>
                      <div class="font-medium">{formatTs(selectedTaskRun.ended_at)}</div>
                    </div>
                    <div>
                      <div class="text-muted-foreground">Errors</div>
                      <div class="font-medium">{selectedTaskRun.error_count}</div>
                    </div>
                    <div>
                      <div class="text-muted-foreground">Interrupts</div>
                      <div class="font-medium">{selectedTaskRun.interrupt_count}</div>
                    </div>
                    <div>
                      <div class="text-muted-foreground">Input tokens</div>
                      <div class="font-medium">{selectedTaskRun.token_input.toLocaleString()}</div>
                    </div>
                    <div>
                      <div class="text-muted-foreground">Output tokens</div>
                      <div class="font-medium">{selectedTaskRun.token_output.toLocaleString()}</div>
                    </div>
                    <div>
                      <div class="text-muted-foreground">Model</div>
                      <div class="font-medium break-all">{selectedTaskRun.model || "—"}</div>
                    </div>
                    <div>
                      <div class="text-muted-foreground">Runner version</div>
                      <div class="font-medium break-all">{selectedTaskRun.agent_system_version || selectedTaskRun.toolchain_version || "—"}</div>
                    </div>
                    <div class="col-span-2">
                      <div class="text-muted-foreground">Git revision</div>
                      <div class="font-medium break-all font-mono">{selectedTaskRun.git_revision || "—"}</div>
                    </div>
                  </div>

                  {#if selectedTaskRun.metadata?.tools?.length}
                    <div>
                      <div class="text-sm text-muted-foreground mb-2">Tools</div>
                      <div class="flex flex-wrap gap-2">
                        {#each selectedTaskRun.metadata.tools as toolName}
                          <Badge variant="outline" class="font-mono text-xs">{toolName}</Badge>
                        {/each}
                      </div>
                    </div>
                  {/if}
                </div>

                <Separator />

                <div class="space-y-3">
                  <div class="flex items-center justify-between">
                    <div class="font-medium">After-Action Report</div>
                    <div class="flex gap-2">
                      <Button variant="outline" size="sm" on:click={generateTaskRunAfterActionReport} disabled={loadingTaskRunAfterActionReport}>
                        {loadingTaskRunAfterActionReport ? "Generating..." : "Generate report"}
                      </Button>
                      <Button variant="outline" size="sm" on:click={copyTaskRunAfterActionReportMarkdown} disabled={!taskRunAfterActionReport?.markdown}>
                        Copy markdown
                      </Button>
                    </div>
                  </div>

                  {#if taskRunAfterActionReport}
                    <div class="rounded-xl border p-3 space-y-3 bg-muted/10">
                      <div class="flex items-center gap-2">
                        <Badge variant={taskRunAfterActionReport.status === "ready" ? "secondary" : "outline"}>
                          {taskRunAfterActionReport.status}
                        </Badge>
                        {#if taskRunAfterActionReport.canonical_outcome}
                          <Badge variant="outline">
                            {taskRunAfterActionReport.canonical_outcome.outcome_label}
                          </Badge>
                        {/if}
                      </div>

                      {#if taskRunAfterActionReport.sections?.what_happened?.length}
                        <div>
                          <div class="text-xs uppercase tracking-wide text-muted-foreground mb-1">What happened</div>
                          <div class="space-y-1">
                            {#each taskRunAfterActionReport.sections.what_happened as item, idx (`aar-wh-${idx}`)}
                              <div class="text-sm">• {item}</div>
                            {/each}
                          </div>
                        </div>
                      {/if}

                      {#if taskRunAfterActionReport.sections?.variance_vs_expected?.length}
                        <div>
                          <div class="text-xs uppercase tracking-wide text-muted-foreground mb-1">Variance vs expected</div>
                          <div class="space-y-1">
                            {#each taskRunAfterActionReport.sections.variance_vs_expected as item, idx (`aar-var-${idx}`)}
                              <div class="text-sm">• {item}</div>
                            {/each}
                          </div>
                        </div>
                      {/if}

                      {#if taskRunAfterActionReport.sections?.risks?.length}
                        <div>
                          <div class="text-xs uppercase tracking-wide text-muted-foreground mb-1">Top risks</div>
                          <div class="space-y-1">
                            {#each taskRunAfterActionReport.sections.risks as item, idx (`aar-risk-${idx}`)}
                              <div class="text-sm">• {item}</div>
                            {/each}
                          </div>
                        </div>
                      {/if}

                      {#if taskRunAfterActionReport.sections?.remediation?.length}
                        <div>
                          <div class="text-xs uppercase tracking-wide text-muted-foreground mb-1">Remediation</div>
                          <div class="space-y-1">
                            {#each taskRunAfterActionReport.sections.remediation as item, idx (`aar-rem-${idx}`)}
                              <div class="text-sm">• {item}</div>
                            {/each}
                          </div>
                        </div>
                      {/if}
                    </div>
                  {:else}
                    <div class="text-sm text-muted-foreground">
                      Generate a structured post-run report from task telemetry and canonical outcome.
                    </div>
                  {/if}
                </div>

                <Separator />

                <div class="space-y-3">
                  <div class="flex items-center justify-between">
                    <div class="font-medium">Outcomes</div>
                    <Badge variant="secondary">{selectedTaskRun.outcomes?.length || 0}</Badge>
                  </div>

                  {#if selectedTaskRun.outcomes?.length}
                    <div class="space-y-2">
                      {#each selectedTaskRun.outcomes as outcome (outcome.id)}
                        <div class="rounded-xl border p-3 space-y-2 bg-muted/10">
                          <div class="flex flex-wrap gap-2 items-center">
                            <Badge variant="secondary">{outcome.outcome_label}</Badge>
                            <Badge variant="outline">{outcome.evaluation_type}</Badge>
                            {#if outcome.is_canonical}
                              <Badge variant="outline">canonical</Badge>
                            {/if}
                            {#if outcome.requires_human_intervention}
                              <Badge variant="outline">human intervention</Badge>
                            {/if}
                          </div>
                          <div class="text-xs text-muted-foreground">
                            {formatTs(outcome.evaluated_at)}{#if outcome.evaluator} by {outcome.evaluator}{/if}
                          </div>
                          {#if outcome.failure_mode}
                            <div class="text-sm"><span class="font-medium">Failure mode:</span> {outcome.failure_mode}</div>
                          {/if}
                          {#if outcome.notes}
                            <div class="text-sm whitespace-pre-wrap">{outcome.notes}</div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {:else}
                    <div class="text-sm text-muted-foreground">No outcomes recorded yet.</div>
                  {/if}
                </div>

                <Separator />

                <div class="space-y-3">
                  <div class="font-medium">Add Outcome</div>

                  <div class="grid grid-cols-2 gap-3">
                    <div class="space-y-1">
                      <Label>Evaluation type</Label>
                      <Select bind:value={taskRunOutcome.evaluation_type} options={evaluationTypeOptions} />
                    </div>
                    <div class="space-y-1">
                      <Label>Outcome</Label>
                      <Select bind:value={taskRunOutcome.outcome_label} options={outcomeLabelOptions} on:change={handleOutcomeLabelChange} />
                      <div class="text-xs text-muted-foreground">
                        {outcomeLabelHelp[taskRunOutcome.outcome_label]}
                      </div>
                    </div>
                  </div>

                  <div class="grid grid-cols-2 gap-3">
                    <div class="space-y-1">
                      <Label>Correctness</Label>
                      <Input bind:value={taskRunOutcome.correctness_score} type="number" min="0" max="1" step="0.1" placeholder="0.0 - 1.0" />
                    </div>
                    <div class="space-y-1">
                      <Label>Safety</Label>
                      <Input bind:value={taskRunOutcome.safety_score} type="number" min="0" max="1" step="0.1" placeholder="0.0 - 1.0" />
                    </div>
                    <div class="space-y-1">
                      <Label>Efficiency</Label>
                      <Input bind:value={taskRunOutcome.efficiency_score} type="number" min="0" max="1" step="0.1" placeholder="0.0 - 1.0" />
                    </div>
                    <div class="space-y-1">
                      <Label>Reproducibility</Label>
                      <Input bind:value={taskRunOutcome.reproducibility_score} type="number" min="0" max="1" step="0.1" placeholder="0.0 - 1.0" />
                    </div>
                  </div>

                  {#if shouldShowFailureFields}
                    <div class="grid grid-cols-2 gap-3">
                      <div class="space-y-1">
                        <Label>Failure mode{requiresFailureMode ? " *" : ""}</Label>
                        <Select bind:value={taskRunOutcome.failure_mode} options={failureModeOptions} on:change={handleFailureModeChange} />
                      </div>
                      <div class="space-y-1">
                        <Label>Failure subtype</Label>
                        <Select bind:value={taskRunOutcome.failure_subtype} options={failureSubtypeOptions} />
                      </div>
                    </div>
                  {/if}

                  <div class="space-y-1">
                    <Label>Evaluator</Label>
                    <Input bind:value={taskRunOutcome.evaluator} placeholder="web-ui" />
                  </div>

                  <label class="flex items-center gap-2 text-sm">
                    <input bind:checked={taskRunOutcome.requires_human_intervention} type="checkbox" class="w-4 h-4" />
                    Requires human intervention
                  </label>

                  <label class="flex items-center gap-2 text-sm">
                    <input bind:checked={taskRunOutcome.is_canonical} type="checkbox" class="w-4 h-4" />
                    Mark as canonical outcome
                  </label>

                  <div class="space-y-1">
                    <Label>Notes</Label>
                    <Textarea bind:value={taskRunOutcome.notes} class="min-h-[120px]" placeholder="Assessment notes, evidence summary, failure explanation..." />
                  </div>

                  <div class="flex gap-2">
                    <Button on:click={saveTaskRunOutcome}>Save outcome</Button>
                    <Button variant="outline" on:click={resetOutcomeForm}>Reset</Button>
                  </div>
                </div>
              {:else}
                <div class="text-sm text-muted-foreground">
                  Select a task run to inspect its summary and add outcomes.
                </div>
              {/if}
            </CardContent>
          </Card>
        </div>
