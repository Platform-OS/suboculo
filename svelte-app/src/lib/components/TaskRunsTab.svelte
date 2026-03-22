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
  let reliabilityKpiCompare = null;
  let reliabilityTrends = null;
  let reliabilityTrendInsights = null;
  let reliabilityFailureModeTrends = null;
  let reliabilityReview = null;
  let taskRunAfterActionReport = null;
  let taskRunAfterActionReportCache = new Map();
  let loadingTaskRunAfterActionReport = false;
  let showKpiDefinitions = false;
  let reliabilityTrendBucket = "day";
  let reliabilityTrendWindowDays = "30";
  let reliabilityKpiComparePreset = "7";
  let reliabilityKpiCompareMode = "preset";
  let reliabilityKpiComparePeriodAFrom = "";
  let reliabilityKpiComparePeriodATo = "";
  let reliabilityKpiComparePeriodBFrom = "";
  let reliabilityKpiComparePeriodBTo = "";
  let hasHydratedStateFromUrl = false;
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
  const reliabilityKpiComparePresetOptions = [
    { value: "7", label: "Last 7 vs previous 7" },
    { value: "14", label: "Last 14 vs previous 14" },
    { value: "30", label: "Last 30 vs previous 30" }
  ];
  const reliabilityKpiCompareModeOptions = [
    { value: "preset", label: "Preset window" },
    { value: "custom", label: "Custom A/B ranges" }
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
    await loadTaskRuns();
  });

  onDestroy(() => {
    clearTimeout(taskRunsLoadTimer);
  });

  function scheduleLoadTaskRuns() {
    clearTimeout(taskRunsLoadTimer);
    taskRunsLoadTimer = setTimeout(() => {
      loadTaskRuns();
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

  async function loadTaskRuns() {
    try {
      loadingTaskRuns = true;
      const filters = {
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

      const compareFilters = buildKpiCompareFilters(filters);
      const [result, summary, kpis, kpisByRunner, kpiCompare, trends, trendInsights, failureModeTrends, review] = await Promise.all([
        api.getTaskRuns(filters),
        api.getTaskRunOutcomeSummary(filters),
        api.getReliabilityKpis(filters),
        api.getReliabilityKpisByRunner(filters),
        api.getReliabilityKpiCompare(compareFilters),
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
        }),
        api.getReliabilityReview({
          ...filters,
          bucket: reliabilityTrendBucket
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
      reliabilityKpiCompare = kpiCompare;
      reliabilityTrends = trends;
      reliabilityTrendInsights = trendInsights;
      reliabilityFailureModeTrends = failureModeTrends;
      reliabilityReview = review;

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
      reliabilityKpiCompare = null;
      reliabilityTrends = null;
      reliabilityTrendInsights = null;
      reliabilityFailureModeTrends = null;
      reliabilityReview = null;
    } finally {
      loadingTaskRuns = false;
    }
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

  async function copyReliabilityReviewMarkdown() {
    if (!reliabilityReview?.markdown) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(reliabilityReview.markdown);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = reliabilityReview.markdown;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      showNotice('Reliability review copied to clipboard', 'success');
    } catch (err) {
      console.error('Failed to copy reliability review:', err);
      showNotice('Failed to copy reliability review', 'error');
    }
  }

  async function copyKpiCompareShareLink() {
    const link = window.location.href;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = link;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      showNotice("KPI compare link copied", "success");
    } catch (err) {
      console.error("Failed to copy KPI compare link:", err);
      showNotice("Failed to copy KPI compare link", "error");
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

  function formatTs(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString();
  }

  function formatPercent(value) {
    if (value == null || Number.isNaN(value)) return "—";
    return `${(value * 100).toFixed(1)}%`;
  }

  function formatMoney(value) {
    if (value == null || Number.isNaN(value)) return "—";
    return `$${Number(value).toFixed(4)}`;
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

  function formatSignedPercentDelta(value) {
    if (value == null || Number.isNaN(value)) return "—";
    const pct = value * 100;
    const sign = pct > 0 ? "+" : "";
    return `${sign}${pct.toFixed(1)}%`;
  }

  function formatSignedNumberDelta(value, precision = 0) {
    if (value == null || Number.isNaN(value)) return "—";
    const sign = value > 0 ? "+" : "";
    return `${sign}${Number(value).toFixed(precision)}`;
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

  function getPeriodGuardrails(period, thresholds) {
    const guards = [];
    const canonicalCount = period?.counts?.with_canonical_outcome ?? 0;
    const knownCostSuccessCount = period?.counts?.successful_runs_with_known_cost ?? 0;
    const minCanonical = thresholds?.min_canonical_sample ?? 0;
    const minCost = thresholds?.min_success_sample_for_cost ?? 0;

    if (canonicalCount < minCanonical) {
      guards.push({
        key: "canonical",
        severity: "warn",
        message: `Canonical outcomes ${canonicalCount}/${minCanonical}`
      });
    }
    if (knownCostSuccessCount < minCost) {
      guards.push({
        key: "cost",
        severity: "warn",
        message: `Known-cost successes ${knownCostSuccessCount}/${minCost}`
      });
    }
    if (!guards.length) {
      guards.push({
        key: "ok",
        severity: "ok",
        message: "Guardrails satisfied"
      });
    }
    return guards;
  }

  function isMetricGuardrailSatisfied(metricKey, period, thresholds) {
    const canonicalCount = period?.counts?.with_canonical_outcome ?? 0;
    const knownCostSuccessCount = period?.counts?.successful_runs_with_known_cost ?? 0;
    const minCanonical = thresholds?.min_canonical_sample ?? 0;
    const minCost = thresholds?.min_success_sample_for_cost ?? 0;

    if (metricKey === "cost_per_success") {
      return knownCostSuccessCount >= minCost;
    }
    if (["success_rate", "first_pass_rate", "retry_rate", "intervention_rate"].includes(metricKey)) {
      return canonicalCount >= minCanonical;
    }
    return true;
  }

  function getMetricSampleNote(metricKey, comparePayload) {
    if (!comparePayload) return "";
    const periodAOk = isMetricGuardrailSatisfied(metricKey, comparePayload.period_a, comparePayload.thresholds);
    const periodBOk = isMetricGuardrailSatisfied(metricKey, comparePayload.period_b, comparePayload.thresholds);
    if (periodAOk && periodBOk) return "";
    return "Insufficient sample";
  }

  function toIsoStartOfDay(dateInput) {
    if (!dateInput) return null;
    const value = new Date(`${dateInput}T00:00:00`);
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }

  function toIsoEndOfDay(dateInput) {
    if (!dateInput) return null;
    const value = new Date(`${dateInput}T23:59:59.999`);
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }

  function buildKpiCompareFilters(baseFilters) {
    if (reliabilityKpiCompareMode === "custom") {
      const aFrom = toIsoStartOfDay(reliabilityKpiComparePeriodAFrom);
      const aTo = toIsoEndOfDay(reliabilityKpiComparePeriodATo);
      const bFrom = toIsoStartOfDay(reliabilityKpiComparePeriodBFrom);
      const bTo = toIsoEndOfDay(reliabilityKpiComparePeriodBTo);

      if (aFrom && aTo && bFrom && bTo) {
        return {
          ...baseFilters,
          period_a_from: aFrom,
          period_a_to: aTo,
          period_b_from: bFrom,
          period_b_to: bTo
        };
      }
    }

    return {
      ...baseFilters,
      period_days: reliabilityKpiComparePreset
    };
  }

  function formatPeriodRange(period) {
    if (!period?.from || !period?.to) return "—";
    const from = new Date(period.from);
    const to = new Date(period.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return `${period.from} → ${period.to}`;
    return `${from.toLocaleDateString()} → ${to.toLocaleDateString()}`;
  }

  function getDeltaTrend(metricKey, delta) {
    if (delta == null || Number.isNaN(delta)) return { label: "Insufficient data", tone: "muted" };

    const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    if (direction === "flat") return { label: "No change", tone: "muted" };

    const higherIsBetter = metricKey === "success_rate" || metricKey === "first_pass_rate";
    const lowerIsBetter = metricKey === "retry_rate" || metricKey === "intervention_rate" || metricKey === "cost_per_success";

    if (higherIsBetter) {
      return direction === "up"
        ? { label: "Improving", tone: "good" }
        : { label: "Degrading", tone: "bad" };
    }
    if (lowerIsBetter) {
      return direction === "down"
        ? { label: "Improving", tone: "good" }
        : { label: "Degrading", tone: "bad" };
    }

    return direction === "up"
      ? { label: "Higher", tone: "neutral" }
      : { label: "Lower", tone: "neutral" };
  }

  function compareToneClass(tone) {
    if (tone === "good") return "text-green-700";
    if (tone === "bad") return "text-red-700";
    return "text-muted-foreground";
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

  $: if (
    hasHydratedStateFromUrl &&
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
  ) {
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

        <Card class="rounded-2xl shadow-sm">
          <CardContent class="p-4 md:p-5 space-y-4">
            <div class="flex items-center justify-between gap-2">
              <div class="text-base font-semibold">Reliability Review</div>
              <Button variant="outline" size="sm" on:click={copyReliabilityReviewMarkdown} disabled={!reliabilityReview?.markdown}>
                Copy markdown
              </Button>
            </div>

            {#if reliabilityReview}
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div class="rounded-xl border p-3 bg-muted/10">
                  <div class="text-xs text-muted-foreground">Task runs</div>
                  <div class="text-xl font-semibold">{reliabilityReview.kpis?.counts?.task_runs ?? 0}</div>
                </div>
                <div class="rounded-xl border p-3 bg-muted/10">
                  <div class="text-xs text-muted-foreground">Success rate</div>
                  <div class="text-xl font-semibold">{formatPercent(reliabilityReview.kpis?.rates?.success_rate)}</div>
                </div>
                <div class="rounded-xl border p-3 bg-muted/10">
                  <div class="text-xs text-muted-foreground">Retry rate</div>
                  <div class="text-xl font-semibold">{formatPercent(reliabilityReview.kpis?.rates?.retry_rate)}</div>
                </div>
                <div class="rounded-xl border p-3 bg-muted/10">
                  <div class="text-xs text-muted-foreground">Cost per success</div>
                  <div class="text-xl font-semibold">{formatMoney(reliabilityReview.kpis?.cost?.cost_per_success)}</div>
                </div>
              </div>

              <div class="rounded-xl border p-3 space-y-2">
                <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Anomalies</div>
                {#if reliabilityReview.anomalies?.length}
                  <div class="flex flex-wrap gap-1">
                    {#each reliabilityReview.anomalies as anomaly (`review-${anomaly.code}`)}
                      <Badge variant={anomaly.severity === "high" ? "destructive" : "outline"} title={anomaly.message}>
                        {formatLabel(anomaly.code)}
                      </Badge>
                    {/each}
                  </div>
                {:else}
                  <div class="text-sm text-muted-foreground">No anomaly flags in current scope.</div>
                {/if}
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <button
                  type="button"
                  class="rounded-xl border p-3 text-left hover:bg-muted/20 transition-colors"
                  on:click={openNeedsLabelingQueue}
                >
                  <div class="text-xs text-muted-foreground">Needs labeling</div>
                  <div class="text-2xl font-semibold">{reliabilityReview.labeling_backlog?.no_canonical_outcome_runs ?? 0}</div>
                  <div class="text-xs text-muted-foreground mt-1">Click to open labeling queue</div>
                </button>

                <div class="rounded-xl border p-3 space-y-2">
                  <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Top failing runs</div>
                  {#if reliabilityReview.top_failing_runs?.length}
                    <div class="space-y-1">
                      {#each reliabilityReview.top_failing_runs as run (`review-run-${run.id}`)}
                        <button
                          type="button"
                          class="w-full text-left text-sm rounded px-2 py-1 hover:bg-muted/20"
                          on:click={() => viewTaskRun(run.id)}
                        >
                          <div class="font-mono truncate">{run.task_key}</div>
                          <div class="text-xs text-muted-foreground">
                            {run.canonical_outcome_label || "unknown"} · errors {run.error_count} · {formatMoney(run.estimated_cost)}
                          </div>
                        </button>
                      {/each}
                    </div>
                  {:else}
                    <div class="text-sm text-muted-foreground">No failing runs in current scope.</div>
                  {/if}
                </div>
              </div>
            {:else}
              <div class="text-sm text-muted-foreground">No review data in current scope.</div>
            {/if}
          </CardContent>
        </Card>

        <Card class="rounded-2xl shadow-sm">
          <CardContent class="p-4 md:p-5 space-y-4">
            <div class="flex items-center justify-between gap-3 flex-wrap">
              <div class="text-base font-semibold">KPI Compare</div>
              <div class="flex items-center gap-2">
                <Select bind:value={reliabilityKpiCompareMode} options={reliabilityKpiCompareModeOptions} />
                {#if reliabilityKpiCompareMode === "preset"}
                  <Select bind:value={reliabilityKpiComparePreset} options={reliabilityKpiComparePresetOptions} />
                {/if}
                <Button variant="outline" size="sm" on:click={copyKpiCompareShareLink}>
                  Copy share link
                </Button>
              </div>
            </div>

            {#if reliabilityKpiCompareMode === "custom"}
              <div class="rounded-xl border p-3 bg-muted/10 space-y-3">
                <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Custom A/B ranges</div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div class="space-y-2">
                    <div class="text-xs text-muted-foreground">Period A (current)</div>
                    <div class="grid grid-cols-2 gap-2">
                      <Input bind:value={reliabilityKpiComparePeriodAFrom} type="date" />
                      <Input bind:value={reliabilityKpiComparePeriodATo} type="date" />
                    </div>
                  </div>
                  <div class="space-y-2">
                    <div class="text-xs text-muted-foreground">Period B (baseline)</div>
                    <div class="grid grid-cols-2 gap-2">
                      <Input bind:value={reliabilityKpiComparePeriodBFrom} type="date" />
                      <Input bind:value={reliabilityKpiComparePeriodBTo} type="date" />
                    </div>
                  </div>
                </div>
                {#if !(reliabilityKpiComparePeriodAFrom && reliabilityKpiComparePeriodATo && reliabilityKpiComparePeriodBFrom && reliabilityKpiComparePeriodBTo)}
                  <div class="text-xs text-muted-foreground">
                    Fill all four dates to activate custom compare; otherwise preset window is used.
                  </div>
                {/if}
              </div>
            {/if}

            {#if reliabilityKpiCompare}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div class="rounded-xl border p-3 bg-muted/10">
                  <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Period A (current)</div>
                  <div class="text-sm">{formatPeriodRange(reliabilityKpiCompare.period_a)}</div>
                  <div class="text-xs text-muted-foreground mt-1">{reliabilityKpiCompare.period_a?.counts?.task_runs ?? 0} runs</div>
                  <div class="mt-2 flex flex-wrap gap-1">
                    {#each getPeriodGuardrails(reliabilityKpiCompare.period_a, reliabilityKpiCompare.thresholds) as guard (`a-${guard.key}`)}
                      <Badge variant={guard.severity === "ok" ? "outline" : "secondary"}>{guard.message}</Badge>
                    {/each}
                  </div>
                </div>
                <div class="rounded-xl border p-3 bg-muted/10">
                  <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Period B (baseline)</div>
                  <div class="text-sm">{formatPeriodRange(reliabilityKpiCompare.period_b)}</div>
                  <div class="text-xs text-muted-foreground mt-1">{reliabilityKpiCompare.period_b?.counts?.task_runs ?? 0} runs</div>
                  <div class="mt-2 flex flex-wrap gap-1">
                    {#each getPeriodGuardrails(reliabilityKpiCompare.period_b, reliabilityKpiCompare.thresholds) as guard (`b-${guard.key}`)}
                      <Badge variant={guard.severity === "ok" ? "outline" : "secondary"}>{guard.message}</Badge>
                    {/each}
                  </div>
                </div>
              </div>

              <div class="overflow-auto rounded-xl border">
                <table class="min-w-full text-sm">
                  <thead class="bg-muted/20 text-xs text-muted-foreground uppercase tracking-wide">
                    <tr>
                      <th class="px-3 py-2 text-left">Metric</th>
                      <th class="px-3 py-2 text-right">Period A</th>
                      <th class="px-3 py-2 text-right">Period B</th>
                      <th class="px-3 py-2 text-right">Delta</th>
                      <th class="px-3 py-2 text-right">Direction</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr class="border-t">
                      <td class="px-3 py-2">Success rate</td>
                      <td class="px-3 py-2 text-right">{formatPercent(reliabilityKpiCompare.period_a?.rates?.success_rate)}</td>
                      <td class="px-3 py-2 text-right">{formatPercent(reliabilityKpiCompare.period_b?.rates?.success_rate)}</td>
                      <td class="px-3 py-2 text-right">{formatSignedPercentDelta(reliabilityKpiCompare.deltas?.rates?.success_rate)}</td>
                      <td class={`px-3 py-2 text-right ${compareToneClass(getDeltaTrend("success_rate", reliabilityKpiCompare.deltas?.rates?.success_rate).tone)}`}>
                        {#if getMetricSampleNote("success_rate", reliabilityKpiCompare)}
                          <span class="text-muted-foreground">{getMetricSampleNote("success_rate", reliabilityKpiCompare)}</span>
                        {:else}
                          {getDeltaTrend("success_rate", reliabilityKpiCompare.deltas?.rates?.success_rate).label}
                        {/if}
                      </td>
                    </tr>
                    <tr class="border-t">
                      <td class="px-3 py-2">First-pass rate</td>
                      <td class="px-3 py-2 text-right">{formatPercent(reliabilityKpiCompare.period_a?.rates?.first_pass_rate)}</td>
                      <td class="px-3 py-2 text-right">{formatPercent(reliabilityKpiCompare.period_b?.rates?.first_pass_rate)}</td>
                      <td class="px-3 py-2 text-right">{formatSignedPercentDelta(reliabilityKpiCompare.deltas?.rates?.first_pass_rate)}</td>
                      <td class={`px-3 py-2 text-right ${compareToneClass(getDeltaTrend("first_pass_rate", reliabilityKpiCompare.deltas?.rates?.first_pass_rate).tone)}`}>
                        {#if getMetricSampleNote("first_pass_rate", reliabilityKpiCompare)}
                          <span class="text-muted-foreground">{getMetricSampleNote("first_pass_rate", reliabilityKpiCompare)}</span>
                        {:else}
                          {getDeltaTrend("first_pass_rate", reliabilityKpiCompare.deltas?.rates?.first_pass_rate).label}
                        {/if}
                      </td>
                    </tr>
                    <tr class="border-t">
                      <td class="px-3 py-2">Retry rate</td>
                      <td class="px-3 py-2 text-right">{formatPercent(reliabilityKpiCompare.period_a?.rates?.retry_rate)}</td>
                      <td class="px-3 py-2 text-right">{formatPercent(reliabilityKpiCompare.period_b?.rates?.retry_rate)}</td>
                      <td class="px-3 py-2 text-right">{formatSignedPercentDelta(reliabilityKpiCompare.deltas?.rates?.retry_rate)}</td>
                      <td class={`px-3 py-2 text-right ${compareToneClass(getDeltaTrend("retry_rate", reliabilityKpiCompare.deltas?.rates?.retry_rate).tone)}`}>
                        {#if getMetricSampleNote("retry_rate", reliabilityKpiCompare)}
                          <span class="text-muted-foreground">{getMetricSampleNote("retry_rate", reliabilityKpiCompare)}</span>
                        {:else}
                          {getDeltaTrend("retry_rate", reliabilityKpiCompare.deltas?.rates?.retry_rate).label}
                        {/if}
                      </td>
                    </tr>
                    <tr class="border-t">
                      <td class="px-3 py-2">Intervention rate</td>
                      <td class="px-3 py-2 text-right">{formatPercent(reliabilityKpiCompare.period_a?.rates?.intervention_rate)}</td>
                      <td class="px-3 py-2 text-right">{formatPercent(reliabilityKpiCompare.period_b?.rates?.intervention_rate)}</td>
                      <td class="px-3 py-2 text-right">{formatSignedPercentDelta(reliabilityKpiCompare.deltas?.rates?.intervention_rate)}</td>
                      <td class={`px-3 py-2 text-right ${compareToneClass(getDeltaTrend("intervention_rate", reliabilityKpiCompare.deltas?.rates?.intervention_rate).tone)}`}>
                        {#if getMetricSampleNote("intervention_rate", reliabilityKpiCompare)}
                          <span class="text-muted-foreground">{getMetricSampleNote("intervention_rate", reliabilityKpiCompare)}</span>
                        {:else}
                          {getDeltaTrend("intervention_rate", reliabilityKpiCompare.deltas?.rates?.intervention_rate).label}
                        {/if}
                      </td>
                    </tr>
                    <tr class="border-t">
                      <td class="px-3 py-2">Cost per success</td>
                      <td class="px-3 py-2 text-right">{formatMoney(reliabilityKpiCompare.period_a?.cost?.cost_per_success)}</td>
                      <td class="px-3 py-2 text-right">{formatMoney(reliabilityKpiCompare.period_b?.cost?.cost_per_success)}</td>
                      <td class="px-3 py-2 text-right">{formatSignedNumberDelta(reliabilityKpiCompare.deltas?.cost?.cost_per_success, 4)}</td>
                      <td class={`px-3 py-2 text-right ${compareToneClass(getDeltaTrend("cost_per_success", reliabilityKpiCompare.deltas?.cost?.cost_per_success).tone)}`}>
                        {#if getMetricSampleNote("cost_per_success", reliabilityKpiCompare)}
                          <span class="text-muted-foreground">{getMetricSampleNote("cost_per_success", reliabilityKpiCompare)}</span>
                        {:else}
                          {getDeltaTrend("cost_per_success", reliabilityKpiCompare.deltas?.cost?.cost_per_success).label}
                        {/if}
                      </td>
                    </tr>
                    <tr class="border-t">
                      <td class="px-3 py-2">Task runs</td>
                      <td class="px-3 py-2 text-right">{reliabilityKpiCompare.period_a?.counts?.task_runs ?? 0}</td>
                      <td class="px-3 py-2 text-right">{reliabilityKpiCompare.period_b?.counts?.task_runs ?? 0}</td>
                      <td class="px-3 py-2 text-right">{formatSignedNumberDelta(reliabilityKpiCompare.deltas?.counts?.task_runs, 0)}</td>
                      <td class={`px-3 py-2 text-right ${compareToneClass(getDeltaTrend("task_runs", reliabilityKpiCompare.deltas?.counts?.task_runs).tone)}`}>
                        {getDeltaTrend("task_runs", reliabilityKpiCompare.deltas?.counts?.task_runs).label}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div class="rounded-xl border p-3 space-y-2">
                  <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Current period flags</div>
                  {#if reliabilityKpiCompare.period_a?.anomalies?.length}
                    <div class="flex flex-wrap gap-1">
                      {#each reliabilityKpiCompare.period_a.anomalies as anomaly (`cmp-a-${anomaly.code}`)}
                        <Badge variant={anomaly.severity === "high" ? "destructive" : "outline"} title={anomaly.message}>
                          {formatLabel(anomaly.code)}
                        </Badge>
                      {/each}
                    </div>
                  {:else}
                    <div class="text-xs text-muted-foreground">No flags.</div>
                  {/if}
                </div>
                <div class="rounded-xl border p-3 space-y-2">
                  <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Previous period flags</div>
                  {#if reliabilityKpiCompare.period_b?.anomalies?.length}
                    <div class="flex flex-wrap gap-1">
                      {#each reliabilityKpiCompare.period_b.anomalies as anomaly (`cmp-b-${anomaly.code}`)}
                        <Badge variant={anomaly.severity === "high" ? "destructive" : "outline"} title={anomaly.message}>
                          {formatLabel(anomaly.code)}
                        </Badge>
                      {/each}
                    </div>
                  {:else}
                    <div class="text-xs text-muted-foreground">No flags.</div>
                  {/if}
                </div>
              </div>
            {:else}
              <div class="text-sm text-muted-foreground">No KPI comparison data in current scope.</div>
            {/if}
          </CardContent>
        </Card>

        <Card class="rounded-2xl shadow-sm">
          <CardContent class="p-4 md:p-5 space-y-4">
            <div class="flex items-center justify-between gap-2">
              <div class="text-base font-semibold">Runner Comparison</div>
              <div class="flex items-center gap-2">
                <Button variant="outline" size="sm" on:click={() => showKpiDefinitions = !showKpiDefinitions}>
                  {showKpiDefinitions ? "Hide metric definitions" : "Show metric definitions"}
                </Button>
                {#if loadingTaskRuns}
                  <Badge variant="outline">Updating…</Badge>
                {/if}
              </div>
            </div>

            {#if showKpiDefinitions}
              <div class="rounded-xl border p-3 space-y-2 bg-muted/10">
                <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">KPI Definitions</div>
                {#if kpiDefinitions?.metrics}
                  <div class="space-y-2">
                    {#each Object.entries(kpiDefinitions.metrics) as [metric, definition] (metric)}
                      <div class="text-xs space-y-1">
                        <div class="font-medium">{formatLabel(metric)}</div>
                        <div class="text-muted-foreground">Formula: {definition.formula}</div>
                        <div class="text-muted-foreground">Null when: {definition.null_when}</div>
                      </div>
                    {/each}
                  </div>
                  <div class="text-xs text-muted-foreground">
                    Guardrails: canonical sample >= {kpiDefinitions?.thresholds?.min_canonical_sample ?? "—"}, successful sample for cost >= {kpiDefinitions?.thresholds?.min_success_sample_for_cost ?? "—"}.
                  </div>
                {:else}
                  <div class="text-xs text-muted-foreground">Metric definitions unavailable.</div>
                {/if}
              </div>
            {/if}

            {#if reliabilityKpisByRunner?.by_runner?.length}
              <div class="overflow-auto rounded-xl border">
                <table class="min-w-full text-sm">
                  <thead class="bg-muted/20 text-xs text-muted-foreground uppercase tracking-wide">
                    <tr>
                      <th class="px-3 py-2 text-left">Runner</th>
                      <th class="px-3 py-2 text-right">Runs</th>
                      <th class="px-3 py-2 text-right">With outcome</th>
                      <th class="px-3 py-2 text-right">Success</th>
                      <th class="px-3 py-2 text-right">First-pass</th>
                      <th class="px-3 py-2 text-right">Retry</th>
                      <th class="px-3 py-2 text-right">Intervention</th>
                      <th class="px-3 py-2 text-right">Cost/success</th>
                      <th class="px-3 py-2 text-left">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each reliabilityKpisByRunner.by_runner as row (row.runner)}
                      <tr class="border-t">
                        <td class="px-3 py-2 font-medium">{row.runner}</td>
                        <td class="px-3 py-2 text-right">{row.counts?.task_runs ?? 0}</td>
                        <td class="px-3 py-2 text-right">{row.counts?.with_canonical_outcome ?? 0}</td>
                        <td class="px-3 py-2 text-right">{formatPercent(row.rates?.success_rate)}</td>
                        <td class="px-3 py-2 text-right">{formatPercent(row.rates?.first_pass_rate)}</td>
                        <td class="px-3 py-2 text-right">{formatPercent(row.rates?.retry_rate)}</td>
                        <td class="px-3 py-2 text-right">{formatPercent(row.rates?.intervention_rate)}</td>
                        <td class="px-3 py-2 text-right">{formatMoney(row.cost?.cost_per_success)}</td>
                        <td class="px-3 py-2">
                          {#if row.anomalies?.length}
                            <div class="flex flex-wrap gap-1">
                              {#each row.anomalies as anomaly (`${row.runner}-${anomaly.code}`)}
                                <Badge variant={anomaly.severity === "high" ? "destructive" : "outline"} title={anomaly.message}>
                                  {formatLabel(anomaly.code)}
                                </Badge>
                              {/each}
                            </div>
                          {:else}
                            <span class="text-xs text-muted-foreground">—</span>
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <div class="text-sm text-muted-foreground">No runner comparison data in current scope.</div>
            {/if}
          </CardContent>
        </Card>

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

        <Card class="rounded-2xl shadow-sm">
          <CardContent class="p-4 md:p-5 space-y-4">
            <div class="flex items-center justify-between gap-2">
              <div class="text-base font-semibold">Reliability KPIs</div>
              {#if loadingTaskRuns}
                <Badge variant="outline">Updating…</Badge>
              {/if}
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div class="rounded-xl border p-3 bg-muted/10">
                <div class="text-xs text-muted-foreground">Success rate</div>
                <div class="text-xl font-semibold">{formatPercent(reliabilityKpis?.rates?.success_rate)}</div>
              </div>
              <div class="rounded-xl border p-3 bg-muted/10">
                <div class="text-xs text-muted-foreground">First-pass rate</div>
                <div class="text-xl font-semibold">{formatPercent(reliabilityKpis?.rates?.first_pass_rate)}</div>
              </div>
              <div class="rounded-xl border p-3 bg-muted/10">
                <div class="text-xs text-muted-foreground">Retry rate</div>
                <div class="text-xl font-semibold">{formatPercent(reliabilityKpis?.rates?.retry_rate)}</div>
              </div>
              <div class="rounded-xl border p-3 bg-muted/10">
                <div class="text-xs text-muted-foreground">Cost per success</div>
                <div class="text-xl font-semibold">{formatMoney(reliabilityKpis?.cost?.cost_per_success)}</div>
              </div>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div class="rounded-xl border p-3 bg-muted/10">
                <div class="text-xs text-muted-foreground">Unsafe success rate</div>
                <div class="text-lg font-semibold">{formatPercent(reliabilityKpis?.rates?.unsafe_success_rate)}</div>
              </div>
              <div class="rounded-xl border p-3 bg-muted/10">
                <div class="text-xs text-muted-foreground">Intervention rate</div>
                <div class="text-lg font-semibold">{formatPercent(reliabilityKpis?.rates?.intervention_rate)}</div>
              </div>
              <div class="rounded-xl border p-3 bg-muted/10">
                <div class="text-xs text-muted-foreground">Duration p50 / p95</div>
                <div class="text-lg font-semibold">
                  {#if reliabilityKpis?.duration_ms}
                    {reliabilityKpis.duration_ms.p50 ?? "—"} / {reliabilityKpis.duration_ms.p95 ?? "—"} ms
                  {:else}
                    —
                  {/if}
                </div>
              </div>
              <div class="rounded-xl border p-3 bg-muted/10">
                <div class="text-xs text-muted-foreground">Total estimated cost</div>
                <div class="text-lg font-semibold">{formatMoney(reliabilityKpis?.cost?.total_estimated_cost)}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card class="rounded-2xl shadow-sm">
          <CardContent class="p-4 md:p-5 space-y-4">
            <div class="flex items-center justify-between gap-2">
              <div class="text-base font-semibold">Outcome Summary</div>
              {#if loadingTaskRuns}
                <Badge variant="outline">Updating…</Badge>
              {/if}
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div class="rounded-xl border p-3 bg-muted/10">
                <div class="text-xs text-muted-foreground">Task runs</div>
                <div class="text-xl font-semibold">{taskRunOutcomeSummary?.totals?.task_runs ?? 0}</div>
              </div>
              <div class="rounded-xl border p-3 bg-muted/10">
                <div class="text-xs text-muted-foreground">With canonical outcome</div>
                <div class="text-xl font-semibold">{taskRunOutcomeSummary?.totals?.with_canonical_outcome ?? 0}</div>
              </div>
              <div class="rounded-xl border p-3 bg-muted/10">
                <div class="text-xs text-muted-foreground">No canonical outcome</div>
                <div class="text-xl font-semibold">{taskRunOutcomeSummary?.totals?.no_canonical_outcome ?? 0}</div>
              </div>
              <div class="rounded-xl border p-3 bg-muted/10">
                <div class="text-xs text-muted-foreground">Needs intervention</div>
                <div class="text-xl font-semibold">{taskRunOutcomeSummary?.totals?.requires_human_intervention ?? 0}</div>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              <div class="rounded-xl border p-3 space-y-2">
                <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">By outcome</div>
                {#if taskRunOutcomeSummary?.by_outcome_label?.length}
                  <div class="space-y-1">
                    {#each taskRunOutcomeSummary.by_outcome_label as bucket (bucket.value)}
                      <div class="flex items-center justify-between text-sm">
                        <span>{bucket.value}</span>
                        <Badge variant="outline">{bucket.count}</Badge>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="text-xs text-muted-foreground">No canonical outcomes in current scope.</div>
                {/if}
              </div>
              <div class="rounded-xl border p-3 space-y-2">
                <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">By failure mode</div>
                {#if taskRunOutcomeSummary?.by_failure_mode?.length}
                  <div class="space-y-1">
                    {#each taskRunOutcomeSummary.by_failure_mode as bucket (bucket.value)}
                      <div class="flex items-center justify-between text-sm">
                        <span>{bucket.value}</span>
                        <Badge variant="outline">{bucket.count}</Badge>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="text-xs text-muted-foreground">No failure modes in current scope.</div>
                {/if}
              </div>
              <div class="rounded-xl border p-3 space-y-2">
                <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">By failure subtype</div>
                {#if taskRunOutcomeSummary?.by_failure_subtype?.length}
                  <div class="space-y-1">
                    {#each taskRunOutcomeSummary.by_failure_subtype as bucket (bucket.value)}
                      <div class="flex items-center justify-between text-sm">
                        <span>{bucket.value}</span>
                        <Badge variant="outline">{bucket.count}</Badge>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="text-xs text-muted-foreground">No failure subtypes in current scope.</div>
                {/if}
              </div>
              <div class="rounded-xl border p-3 space-y-2">
                <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">By evaluation type</div>
                {#if taskRunOutcomeSummary?.by_evaluation_type?.length}
                  <div class="space-y-1">
                    {#each taskRunOutcomeSummary.by_evaluation_type as bucket (bucket.value)}
                      <div class="flex items-center justify-between text-sm">
                        <span>{bucket.value}</span>
                        <Badge variant="outline">{bucket.count}</Badge>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="text-xs text-muted-foreground">No evaluations in current scope.</div>
                {/if}
              </div>
            </div>
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
