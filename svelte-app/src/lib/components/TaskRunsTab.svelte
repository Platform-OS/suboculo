<script>
  import { onDestroy, onMount } from "svelte";
  import * as api from "$lib/api.js";
  import TaskRunFiltersPanel from "./TaskRunFiltersPanel.svelte";
  import KpiComparePanel from "./KpiComparePanel.svelte";
  import ReliabilityReviewPanel from "./ReliabilityReviewPanel.svelte";
  import KpiSummaryPanel from "./KpiSummaryPanel.svelte";
  import ReliabilityTrendsPanel from "./ReliabilityTrendsPanel.svelte";
  import TaskRunWorkspace from "./TaskRunWorkspace.svelte";
  import { deriveTaskRunsUiOptions } from "$lib/taskRunsOptions.js";
  import { buildTaskRunsUrl, hydrateTaskRunsStateFromUrl } from "$lib/taskRunsUrlState.js";

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

  function hydrateStateFromUrl() {
    const nextState = hydrateTaskRunsStateFromUrl(window.location.search, {
      taskRunStatusFilter,
      taskRunRunnerFilter,
      taskRunQuery,
      taskRunCanonicalOutcomeFilter,
      taskRunFailureModeFilter,
      taskRunFailureSubtypeFilter,
      taskRunHumanInterventionFilter,
      taskRunNeedsLabelingOnly,
      reliabilityKpiCompareMode,
      reliabilityKpiComparePreset
    });

    taskRunStatusFilter = nextState.taskRunStatusFilter;
    taskRunRunnerFilter = nextState.taskRunRunnerFilter;
    taskRunQuery = nextState.taskRunQuery;
    taskRunCanonicalOutcomeFilter = nextState.taskRunCanonicalOutcomeFilter;
    taskRunFailureModeFilter = nextState.taskRunFailureModeFilter;
    taskRunFailureSubtypeFilter = nextState.taskRunFailureSubtypeFilter;
    taskRunHumanInterventionFilter = nextState.taskRunHumanInterventionFilter;
    taskRunNeedsLabelingOnly = nextState.taskRunNeedsLabelingOnly;
    reliabilityKpiCompareMode = nextState.reliabilityKpiCompareMode;
    reliabilityKpiComparePreset = nextState.reliabilityKpiComparePreset;
    reliabilityKpiComparePeriodAFrom = nextState.reliabilityKpiComparePeriodAFrom;
    reliabilityKpiComparePeriodATo = nextState.reliabilityKpiComparePeriodATo;
    reliabilityKpiComparePeriodBFrom = nextState.reliabilityKpiComparePeriodBFrom;
    reliabilityKpiComparePeriodBTo = nextState.reliabilityKpiComparePeriodBTo;
  }

  function syncStateToUrl() {
    const nextUrl = buildTaskRunsUrl(window.location.search, window.location.pathname, window.location.hash, {
      taskRunStatusFilter,
      taskRunRunnerFilter,
      taskRunQuery,
      taskRunCanonicalOutcomeFilter,
      taskRunFailureModeFilter,
      taskRunFailureSubtypeFilter,
      taskRunHumanInterventionFilter,
      taskRunNeedsLabelingOnly,
      reliabilityKpiCompareMode,
      reliabilityKpiComparePreset,
      reliabilityKpiComparePeriodAFrom,
      reliabilityKpiComparePeriodATo,
      reliabilityKpiComparePeriodBFrom,
      reliabilityKpiComparePeriodBTo
    });
    window.history.replaceState({}, "", nextUrl);
  }

  $: ({
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
    outcomeLabelOptions,
    evaluationTypeOptions,
    failureModeOptions,
    failureSubtypeOptions,
    taskRunCanonicalOutcomeOptions,
    taskRunFailureModeOptions,
    taskRunFailureSubtypeValues,
    taskRunFailureSubtypeOptions,
    taskRunHumanInterventionOptions
  } = deriveTaskRunsUiOptions({
    facets,
    outcomeTaxonomy,
    fallbackEvaluationTypes,
    fallbackOutcomeLabels,
    fallbackFailureTaxonomy,
    fallbackFailureModes,
    fallbackRequiredFailureLabels,
    taskRunOutcome,
    taskRunFailureModeFilter
  }));

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

        <TaskRunFiltersPanel
          {loadingTaskRuns}
          bind:taskRunQuery
          bind:taskRunStatusFilter
          bind:taskRunRunnerFilter
          bind:taskRunCanonicalOutcomeFilter
          bind:taskRunFailureModeFilter
          bind:taskRunFailureSubtypeFilter
          bind:taskRunHumanInterventionFilter
          bind:taskRunNeedsLabelingOnly
          {taskRunStatusOptions}
          {taskRunRunnerOptions}
          {taskRunCanonicalOutcomeOptions}
          {taskRunFailureModeOptions}
          {taskRunFailureSubtypeOptions}
          {taskRunHumanInterventionOptions}
          onRefresh={loadTaskRuns}
          onDeriveTaskRuns={deriveTaskRunsNow}
          onTaskRunCanonicalOutcomeFilterChange={handleTaskRunCanonicalOutcomeFilterChange}
          onTaskRunFailureModeFilterChange={handleTaskRunFailureModeFilterChange}
          onNormalizeTaskRunFailureSubtypeFilter={normalizeTaskRunFailureSubtypeFilter}
          onTaskRunHumanInterventionFilterChange={handleTaskRunHumanInterventionFilterChange}
          onToggleNoCanonicalFilter={toggleNoCanonicalFilter}
          onToggleRequiresHumanFilter={toggleRequiresHumanFilter}
          onToggleNeedsLabelingQueue={toggleNeedsLabelingQueue}
        />

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

        <ReliabilityTrendsPanel
          bind:trendBucket={reliabilityTrendBucket}
          bind:trendWindowDays={reliabilityTrendWindowDays}
          trendBucketOptions={reliabilityTrendBucketOptions}
          trendWindowOptions={reliabilityTrendWindowOptions}
          {reliabilityTrends}
          {reliabilityTrendInsights}
          reliabilityFailureModeTrends={reliabilityFailureModeTrends}
        />

        <TaskRunWorkspace
          {loadingTaskRuns}
          {taskRuns}
          {taskRunsTotal}
          {selectedTaskRun}
          {selectedTaskRunIds}
          {savingBulkOutcomes}
          bind:bulkTaskRunOutcome
          {evaluationTypeOptions}
          {outcomeLabelOptions}
          {failureModeOptions}
          {taskRunAfterActionReport}
          {loadingTaskRunAfterActionReport}
          bind:taskRunOutcome
          {outcomeLabelHelp}
          {shouldShowFailureFields}
          {requiresFailureMode}
          {failureSubtypeOptions}
          onSelectAllVisibleTaskRuns={selectAllVisibleTaskRuns}
          onClearSelectedTaskRuns={clearSelectedTaskRuns}
          onBulkOutcomeLabelChange={handleBulkOutcomeLabelChange}
          onBulkFailureModeChange={handleBulkFailureModeChange}
          onApplyBulkTaskRunOutcome={applyBulkTaskRunOutcome}
          onViewTaskRun={viewTaskRun}
          onToggleTaskRunSelection={toggleTaskRunSelection}
          onCloseTaskRunDetail={() => { selectedTaskRun = null; taskRunAfterActionReport = null; }}
          onGenerateTaskRunAfterActionReport={generateTaskRunAfterActionReport}
          onCopyTaskRunAfterActionReportMarkdown={copyTaskRunAfterActionReportMarkdown}
          onHandleOutcomeLabelChange={handleOutcomeLabelChange}
          onHandleFailureModeChange={handleFailureModeChange}
          onSaveTaskRunOutcome={saveTaskRunOutcome}
          onResetOutcomeForm={resetOutcomeForm}
        />
