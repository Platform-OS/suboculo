<script>
  import { onDestroy, onMount } from "svelte";
  import * as api from "$lib/api.js";
  import TaskRunFiltersPanel from "./TaskRunFiltersPanel.svelte";
  import KpiComparePanel from "./KpiComparePanel.svelte";
  import ReliabilityReviewPanel from "./ReliabilityReviewPanel.svelte";
  import KpiSummaryPanel from "./KpiSummaryPanel.svelte";
  import ReliabilityTrendsPanel from "./ReliabilityTrendsPanel.svelte";
  import TaskRunWorkspace from "./TaskRunWorkspace.svelte";
  import {
    applyBulkTaskRunOutcomeAction,
    copyTaskRunAfterActionReportMarkdownAction,
    generateTaskRunAfterActionReportAction,
    saveTaskRunOutcomeAction,
    viewTaskRunAction
  } from "$lib/taskRunActions.js";
  import {
    clearFailureFieldsIfOutcomeNotRequired,
    handleTaskRunCanonicalOutcomeFilterChangeState,
    handleTaskRunFailureModeFilterChangeState,
    handleTaskRunHumanInterventionFilterChangeState,
    normalizeFailureSubtypeForOutcome,
    normalizeTaskRunFailureSubtypeFilterState,
    openNeedsLabelingQueueState,
    toggleNeedsLabelingQueueState,
    toggleNoCanonicalFilterState,
    toggleRequiresHumanFilterState
  } from "$lib/taskRunsFilterState.js";
  import { fetchTaskRunsBundle, filterSelectedTaskRunIds } from "$lib/taskRunsDataLoader.js";
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

  function applyTaskRunFilterPatch(patch) {
    if (!patch) return;
    if (patch.taskRunStatusFilter !== undefined) taskRunStatusFilter = patch.taskRunStatusFilter;
    if (patch.taskRunRunnerFilter !== undefined) taskRunRunnerFilter = patch.taskRunRunnerFilter;
    if (patch.taskRunQuery !== undefined) taskRunQuery = patch.taskRunQuery;
    if (patch.taskRunCanonicalOutcomeFilter !== undefined) taskRunCanonicalOutcomeFilter = patch.taskRunCanonicalOutcomeFilter;
    if (patch.taskRunFailureModeFilter !== undefined) taskRunFailureModeFilter = patch.taskRunFailureModeFilter;
    if (patch.taskRunFailureSubtypeFilter !== undefined) taskRunFailureSubtypeFilter = patch.taskRunFailureSubtypeFilter;
    if (patch.taskRunHumanInterventionFilter !== undefined) taskRunHumanInterventionFilter = patch.taskRunHumanInterventionFilter;
    if (patch.taskRunNeedsLabelingOnly !== undefined) taskRunNeedsLabelingOnly = patch.taskRunNeedsLabelingOnly;
  }

  async function loadTaskRuns(preparedFilters = null) {
    try {
      loadingTaskRuns = true;
      const filters = preparedFilters || getTaskRunFilters();

      const { result, summary, kpis, kpisByRunner, trends, trendInsights, failureModeTrends } = await fetchTaskRunsBundle({
        api,
        filters,
        trendBucket: reliabilityTrendBucket,
        trendWindowDays: reliabilityTrendWindowDays
      });
      taskRuns = result.taskRuns;
      selectedTaskRunIds = filterSelectedTaskRunIds(result.taskRuns, selectedTaskRunIds);
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
    applyTaskRunFilterPatch(toggleNoCanonicalFilterState({
      taskRunCanonicalOutcomeFilter
    }));
  }

  function toggleRequiresHumanFilter() {
    applyTaskRunFilterPatch(toggleRequiresHumanFilterState({
      taskRunHumanInterventionFilter,
      taskRunCanonicalOutcomeFilter
    }));
  }

  function normalizeTaskRunFailureSubtypeFilter() {
    applyTaskRunFilterPatch(normalizeTaskRunFailureSubtypeFilterState({
      taskRunFailureModeFilter,
      taskRunFailureSubtypeFilter
    }, failureTaxonomy));
  }

  function handleTaskRunCanonicalOutcomeFilterChange() {
    applyTaskRunFilterPatch(handleTaskRunCanonicalOutcomeFilterChangeState({
      taskRunCanonicalOutcomeFilter
    }));
  }

  function handleTaskRunFailureModeFilterChange() {
    applyTaskRunFilterPatch(handleTaskRunFailureModeFilterChangeState({
      taskRunFailureModeFilter,
      taskRunCanonicalOutcomeFilter,
      taskRunFailureSubtypeFilter
    }, failureTaxonomy));
  }

  function handleTaskRunHumanInterventionFilterChange() {
    applyTaskRunFilterPatch(handleTaskRunHumanInterventionFilterChangeState({
      taskRunHumanInterventionFilter,
      taskRunCanonicalOutcomeFilter
    }));
  }

  function toggleNeedsLabelingQueue() {
    applyTaskRunFilterPatch(toggleNeedsLabelingQueueState({
      taskRunNeedsLabelingOnly
    }));
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
    bulkTaskRunOutcome = clearFailureFieldsIfOutcomeNotRequired(bulkTaskRunOutcome, requiredFailureLabels);
  }

  function handleBulkFailureModeChange() {
    const taxonomy = outcomeTaxonomy?.failure_taxonomy || fallbackFailureTaxonomy;
    bulkTaskRunOutcome = normalizeFailureSubtypeForOutcome(bulkTaskRunOutcome, taxonomy);
  }

  async function applyBulkTaskRunOutcome() {
    const requiredFailureLabels = outcomeTaxonomy?.requires_failure_mode_for || fallbackRequiredFailureLabels;
    await applyBulkTaskRunOutcomeAction({
      selectedTaskRunIds,
      bulkTaskRunOutcome,
      requiredFailureLabels,
      setSavingBulkOutcomes: (value) => { savingBulkOutcomes = value; },
      api,
      showNotice,
      loadTaskRuns,
      selectedTaskRun,
      setSelectedTaskRun: (value) => { selectedTaskRun = value; },
      clearSelectedTaskRuns
    });
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
    await viewTaskRunAction({
      id,
      api,
      onOpenTaskRun,
      taskRunAfterActionReportCache,
      setSelectedTaskRun: (value) => { selectedTaskRun = value; },
      setTaskRunAfterActionReport: (value) => { taskRunAfterActionReport = value; },
      setTaskRunAarCache
    });
  }

  async function generateTaskRunAfterActionReport() {
    await generateTaskRunAfterActionReportAction({
      selectedTaskRun,
      api,
      setLoadingTaskRunAfterActionReport: (value) => { loadingTaskRunAfterActionReport = value; },
      setTaskRunAfterActionReport: (value) => { taskRunAfterActionReport = value; },
      setTaskRunAarCache
    });
  }

  async function copyTaskRunAfterActionReportMarkdown() {
    await copyTaskRunAfterActionReportMarkdownAction({
      report: taskRunAfterActionReport,
      showNotice
    });
  }

  function openNeedsLabelingQueue() {
    applyTaskRunFilterPatch(openNeedsLabelingQueueState());
  }

  function resetOutcomeForm() {
    taskRunOutcome = createDefaultOutcomeForm();
  }

  function handleOutcomeLabelChange() {
    const requiredFailureLabels = outcomeTaxonomy?.requires_failure_mode_for || fallbackRequiredFailureLabels;
    taskRunOutcome = clearFailureFieldsIfOutcomeNotRequired(taskRunOutcome, requiredFailureLabels);
  }

  function handleFailureModeChange() {
    const taxonomy = outcomeTaxonomy?.failure_taxonomy || fallbackFailureTaxonomy;
    taskRunOutcome = normalizeFailureSubtypeForOutcome(taskRunOutcome, taxonomy);
  }

  async function saveTaskRunOutcome() {
    await saveTaskRunOutcomeAction({
      selectedTaskRun,
      requiresFailureMode,
      taskRunOutcome,
      api,
      setSelectedTaskRun: (value) => { selectedTaskRun = value; },
      deleteTaskRunAarCache,
      setLoadingTaskRunAfterActionReport: (value) => { loadingTaskRunAfterActionReport = value; },
      setTaskRunAfterActionReport: (value) => { taskRunAfterActionReport = value; },
      setTaskRunAarCache,
      loadTaskRuns,
      resetOutcomeForm
    });
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
