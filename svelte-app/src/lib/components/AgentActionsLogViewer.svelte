<script>
  import { onMount } from "svelte";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import * as api from "$lib/api.js";
  import Card from "./ui/Card.svelte";
  import CardContent from "./ui/CardContent.svelte";
  import Button from "./ui/Button.svelte";
  import Input from "./ui/Input.svelte";
  import Label from "./ui/Label.svelte";
  import Select from "./ui/Select.svelte";
  import Badge from "./ui/Badge.svelte";
  import Separator from "./ui/Separator.svelte";
  import Tabs from "./ui/Tabs.svelte";
  import TabsList from "./ui/TabsList.svelte";
  import TabsTrigger from "./ui/TabsTrigger.svelte";
  import TabsContent from "./ui/TabsContent.svelte";
  import Textarea from "./ui/Textarea.svelte";
  import { Search, Upload, Download, Tag, X, ArrowUpDown, Trash2, Sparkles, FileText, Eye } from "lucide-svelte";

  // Markdown rendering
  marked.setOptions({ breaks: true });

  // State
  let pageItems = [];
  let totalEntries = 0;
  let totalPages = 1;
  let isLoading = false;

  let tagsByKey = {};
  let notesByKey = {};
  let facets = {
    kinds: [],
    types: [],
    tools: [],
    subagents: [],
    roots: [],
    allTags: [],
    runners: [],
    events: [],
    attempts: []
  };

  // Filters
  let query = "";
  let kind = "all";
  let type = "all";
  let tool = "all";
  let subagent = "all";
  let rootSession = "all";
  let tagFilter = "all";
  let runner = "all";
  let event = "all";
  let attempt = "all";

  // Sorting
  let sortKey = "ts";
  let sortDir = "desc";

  // Selection (for details view)
  let selectedKey = null;
  let selected = null;

  // Multi-selection (for analysis)
  let selectedEntries = new Set();
  let lastClickedIndex = null;

  // LLM Analysis state
  let showAnalysisDialog = false;
  let analysisLoading = false;
  let analysisResult = null;
  let analysisError = null;
  let apiKey = '';
  let selectedModel = 'claude-sonnet-4-6';
  let customPrompt = '';

  // Pagination
  let pageSize = 100;
  let page = 1;

  // Stats
  let stats = {
    total: 0,
    avgDur: null
  };

  // Real-time connection status
  let sseConnected = false;

  // Main tab state
  let mainTab = "events";

  // Analysis History state
  let analyses = [];
  let selectedAnalysis = null;
  let loadingAnalyses = false;
  let notice = null;
  let noticeTimer;
  let confirmDialog = null;
  let liveRefreshTimer;

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
  let kpiDefinitions = null;
  let showKpiDefinitions = false;
  let reliabilityTrendBucket = "day";
  let reliabilityTrendWindowDays = "30";
  let outcomeTaxonomy = null;
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

  // Load initial data
  onMount(async () => {
    await loadData();
    await loadOutcomeTaxonomy();
    await loadKpiDefinitions();
    await loadAnalyses();
    await loadTaskRuns();

    // Subscribe to real-time events
    const unsubscribe = api.subscribeToEvents(
      (event) => {
        // On message received
        handleNewEvent(event);
      },
      (connected) => {
        // On connection state change
        sseConnected = connected;
      }
    );

    // Return cleanup function
    return () => {
      unsubscribe();
    };
  });

  // Reactive: fetch when filters change
  $: if (query !== undefined) {
    debouncedFetch();
  }
  $: if (kind || type || tool || subagent || rootSession || tagFilter || runner || event || attempt || sortKey || sortDir || page || pageSize) {
    fetchEntries();
  }

  let debounceTimer;
  function debouncedFetch() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      page = 1;
      fetchEntries();
    }, 300);
  }

  async function loadData() {
    try {
      [tagsByKey, notesByKey, facets, stats] = await Promise.all([
        api.getTags(),
        api.getNotes(),
        api.getFacets(),
        api.getStats()
      ]);
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  }

  async function loadAnalyses() {
    try {
      loadingAnalyses = true;
      analyses = await api.getAnalyses();
    } catch (err) {
      console.error('Failed to load analyses:', err);
    } finally {
      loadingAnalyses = false;
    }
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

  async function loadOutcomeTaxonomy() {
    try {
      outcomeTaxonomy = await api.getOutcomeTaxonomy();
    } catch (err) {
      console.error("Failed to load outcome taxonomy:", err);
      outcomeTaxonomy = null;
    }
  }

  async function loadKpiDefinitions() {
    try {
      kpiDefinitions = await api.getKpiDefinitions();
    } catch (err) {
      console.error("Failed to load KPI definitions:", err);
      kpiDefinitions = null;
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
    } catch (err) {
      console.error('Failed to load task run:', err);
      alert('Failed to load task run');
    }
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

      selectedTaskRun = await api.getTaskRun(selectedTaskRun.id);
      await loadTaskRuns();
      resetOutcomeForm();
    } catch (err) {
      console.error('Failed to save outcome:', err);
      alert(err.message);
    }
  }

  async function viewAnalysis(id) {
    try {
      selectedAnalysis = await api.getAnalysis(id);
    } catch (err) {
      console.error('Failed to load analysis:', err);
      showNotice('Failed to load analysis', 'error');
    }
  }

  async function deleteAnalysisById(id) {
    openConfirmDialog('Delete this saved analysis? This cannot be undone.', async () => {
      try {
        await api.deleteAnalysis(id);
        await loadAnalyses();
        if (selectedAnalysis?.id === id) {
          selectedAnalysis = null;
        }
      } catch (err) {
        console.error('Failed to delete analysis:', err);
        showNotice('Failed to delete analysis', 'error');
      }
    });
  }

  function exportAnalysisAsMarkdown(analysis) {
    const timestamp = new Date(analysis.timestamp).toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `analysis-${analysis.id}-${timestamp}.md`;
    const markdown = `# Agent Actions Analysis\n\n**Date:** ${new Date(analysis.timestamp).toLocaleString()}\n**Model:** ${analysis.model}\n**Events Analyzed:** ${analysis.event_count}\n\n---\n\n## Analysis\n\n${analysis.analysis}\n\n---\n\n*Generated by Suboculo*\n`;

    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleNewEvent(newEvent) {
    // Update stats
    stats.total++;

    // Attempt-level filtering depends on derived task_run mappings from backend,
    // so use canonical refresh instead of incremental updates.
    if (attempt !== "all") {
      scheduleLiveRefresh();
      return;
    }

    // Check if event matches current filters
    if (!matchesFilters(newEvent)) return;

    // For timestamp-sorted views, transcript-derived events can arrive later than
    // their actual event time. Re-fetch the first page instead of incrementally
    // mutating the list so backend ordering remains canonical.
    if (page === 1 && sortKey === "ts") {
      scheduleLiveRefresh();
    } else if (page === 1 && sortDir === "desc") {
      pageItems = [newEvent, ...pageItems];
      if (pageItems.length > pageSize) {
        pageItems = pageItems.slice(0, pageSize);
      }
    }

    // Update facets
    updateFacetsForEvent(newEvent);
  }

  function scheduleLiveRefresh() {
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = setTimeout(() => {
      fetchEntries();
    }, 150);
  }

  function matchesFilters(newEvent) {
    if (runner !== "all" && newEvent.runner !== runner) return false;
    if (event !== "all" && newEvent.event !== event) return false;
    if (tool !== "all" && newEvent.data?.tool !== tool) return false;
    if (kind !== "all" && newEvent.event !== kind) return false;
    // Add more filter checks as needed
    return true;
  }

  function updateFacetsForEvent(newEvent) {
    // Add runner if new
    if (newEvent.runner && !facets.runners.includes(newEvent.runner)) {
      facets.runners = [...facets.runners, newEvent.runner];
    }

    // Add event type if new
    if (newEvent.event && !facets.events.includes(newEvent.event)) {
      facets.events = [...facets.events, newEvent.event];
    }

    // Add tool if new
    if (newEvent.data?.tool && !facets.tools.includes(newEvent.data.tool)) {
      facets.tools = [...facets.tools, newEvent.data.tool];
    }
  }

  async function fetchEntries() {
    if (stats.total === 0) return; // No data uploaded yet

    isLoading = true;
    try {
      const result = await api.getEntries({
        page,
        pageSize,
        kind: kind !== "all" ? kind : undefined,
        type: type !== "all" ? type : undefined,
        tool: tool !== "all" ? tool : undefined,
        subagent: subagent !== "all" ? subagent : undefined,
        rootSession: rootSession !== "all" ? rootSession : undefined,
        tag: tagFilter !== "all" ? tagFilter : undefined,
        runner: runner !== "all" ? runner : undefined,
        event: event !== "all" ? event : undefined,
        attempt: attempt !== "all" ? attempt : undefined,
        query: query || undefined,
        sortKey,
        sortDir
      });

      pageItems = result.entries;
      totalEntries = result.total;
      totalPages = result.totalPages;
      page = result.page;
    } catch (err) {
      console.error('Failed to fetch entries:', err);
    } finally {
      isLoading = false;
    }
  }

  async function addTagToEntry(key, tag) {
    const clean = tag.trim();
    if (!clean) return;

    try {
      await api.addTag(key, clean);

      // Update local state
      if (!tagsByKey[key]) {
        tagsByKey[key] = [];
      }
      if (!tagsByKey[key].includes(clean)) {
        tagsByKey[key] = [...tagsByKey[key], clean].sort();
      }

      // Reload facets
      facets = await api.getFacets();
    } catch (err) {
      console.error('Failed to add tag:', err);
    }
  }

  async function removeTagFromEntry(key, tag) {
    try {
      await api.removeTag(key, tag);

      // Update local state
      if (tagsByKey[key]) {
        tagsByKey[key] = tagsByKey[key].filter(t => t !== tag);
      }

      // Reload facets
      facets = await api.getFacets();
    } catch (err) {
      console.error('Failed to remove tag:', err);
    }
  }

  async function setNoteForEntry(key, note) {
    try {
      await api.setNote(key, note);

      // Update local state
      if (note && note.trim()) {
        notesByKey[key] = note;
      } else {
        delete notesByKey[key];
      }
    } catch (err) {
      console.error('Failed to set note:', err);
    }
  }

  async function clearAllTags() {
    openConfirmDialog('Clear all tags and notes? This cannot be undone.', async () => {
      try {
        await api.importTags({ tagsByKey: {}, notesByKey: {} });
        tagsByKey = {};
        notesByKey = {};
        facets = await api.getFacets();
        showNotice('All tags and notes cleared', 'success');
      } catch (err) {
        console.error('Failed to clear tags:', err);
        showNotice('Failed to clear tags and notes', 'error');
      }
    });
  }

  async function exportTagsData() {
    try {
      const data = await api.exportTags();

      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "agent-actions-tags.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export:', err);
    }
  }

  async function importTagsData(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const obj = JSON.parse(String(reader.result || "{}"));
        await api.importTags(obj);

        // Reload data
        tagsByKey = await api.getTags();
        notesByKey = await api.getNotes();
        facets = await api.getFacets();
      } catch (err) {
        console.error('Failed to import:', err);
        showNotice('Import failed: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  }

  function showNotice(message, tone = 'info') {
    clearTimeout(noticeTimer);
    notice = { message, tone };
    noticeTimer = setTimeout(() => {
      notice = null;
    }, 5000);
  }

  function openConfirmDialog(message, onConfirm) {
    confirmDialog = { message, onConfirm };
  }

  async function confirmDialogAccept() {
    if (!confirmDialog) return;
    const action = confirmDialog.onConfirm;
    confirmDialog = null;
    await action();
  }

  function closeConfirmDialog() {
    confirmDialog = null;
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

  function formatFailureModeRow(bucketRow) {
    if (!bucketRow?.by_mode?.length) return "—";
    return bucketRow.by_mode
      .slice(0, 3)
      .map((modeRow) => `${modeRow.failure_mode} ${modeRow.count} (${formatPercent(modeRow.failure_mode_share)})`)
      .join(", ");
  }

  function selectEntry(key) {
    selectedKey = key;
    selected = pageItems.find(e => e.__key === key) || null;
  }

  // Multi-selection functions
  function toggleSelection(key, index, shiftKey = false) {
    const newSelection = new Set(selectedEntries);

    // Handle shift+click range selection
    if (shiftKey && lastClickedIndex !== null) {
      const start = Math.min(lastClickedIndex, index);
      const end = Math.max(lastClickedIndex, index);

      for (let i = start; i <= end; i++) {
        newSelection.add(pageItems[i].__key);
      }
    } else {
      // Normal toggle
      if (newSelection.has(key)) {
        newSelection.delete(key);
      } else {
        newSelection.add(key);
      }
    }

    selectedEntries = newSelection;
    lastClickedIndex = index;
  }

  function selectAll() {
    selectedEntries = new Set(pageItems.map(e => e.__key));
    lastClickedIndex = null;
  }

  function clearSelection() {
    selectedEntries = new Set();
    lastClickedIndex = null;
  }

  function selectAllVisible() {
    selectedEntries = new Set(pageItems.map(e => e.__key));
    lastClickedIndex = null;
  }

  function selectFirst(count) {
    const keys = pageItems.slice(0, count).map(e => e.__key);
    selectedEntries = new Set(keys);
    lastClickedIndex = null;
  }

  async function analyzeSelection() {
    if (selectedEntries.size === 0) return;

    showAnalysisDialog = true;
    analysisResult = null;
    analysisError = null;
  }

  async function runAnalysis() {
    if (!apiKey.trim()) {
      analysisError = 'API key is required';
      return;
    }

    analysisLoading = true;
    analysisError = null;
    analysisResult = null;

    try {
      const keys = Array.from(selectedEntries);
      const result = await api.analyzeEvents(keys, {
        model: selectedModel,
        apiKey: apiKey.trim(),
        prompt: customPrompt.trim() || undefined
      });

      analysisResult = result;

      // Reload analyses list to include the newly saved analysis
      await loadAnalyses();
    } catch (error) {
      analysisError = error.message;
    } finally {
      analysisLoading = false;
    }
  }

  // Send to CLI state
  let sendToCliMessage = '';
  let sendToCliLoading = false;

  async function sendSelectionToCLI() {
    if (selectedEntries.size === 0) return;

    sendToCliLoading = true;
    sendToCliMessage = '';

    try {
      const keys = Array.from(selectedEntries);
      const result = await api.saveSelection(keys);
      sendToCliMessage = `${result.count} events sent to CLI. In Claude Code, say: "Analyze my selected events"`;

      // Auto-clear message after 8 seconds
      setTimeout(() => {
        sendToCliMessage = '';
      }, 8000);
    } catch (error) {
      sendToCliMessage = `Error: ${error.message}`;
    } finally {
      sendToCliLoading = false;
    }
  }

  function closeAnalysisDialog() {
    showAnalysisDialog = false;
    analysisResult = null;
    analysisError = null;
  }

  function saveAnalysisAsMarkdown() {
    if (!analysisResult) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `analysis-${timestamp}.md`;

    const markdown = `# Agent Actions Analysis

**Date:** ${new Date().toLocaleString()}
**Model:** ${analysisResult.model}
**Events Analyzed:** ${analysisResult.eventCount}

---

## Analysis

${analysisResult.analysis}

---

*Generated by Suboculo*
`;

    // Create download
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Select options
  $: kindOptions = [
    { value: "all", label: "All" },
    ...facets.kinds.map((k) => ({ value: k, label: k })),
  ];

  $: typeOptions = [
    { value: "all", label: "All" },
    ...facets.types.map((t) => ({ value: t, label: t })),
  ];

  $: toolOptions = [
    { value: "all", label: "All" },
    ...facets.tools.map((t) => ({ value: t, label: t })),
  ];

  $: subagentOptions = [
    { value: "all", label: "All" },
    ...facets.subagents.map((s) => ({ value: s, label: s })),
  ];

  $: rootSessionOptions = [
    { value: "all", label: "All" },
    ...facets.roots.map((r) => ({ value: r, label: r })),
  ];

  $: tagFilterOptions = [
    { value: "all", label: "All" },
    ...facets.allTags.map((t) => ({ value: t, label: t })),
  ];

  $: runnerOptions = [
    { value: "all", label: "All" },
    ...facets.runners.map((r) => ({ value: r, label: r })),
  ];

  $: eventOptions = [
    { value: "all", label: "All" },
    ...facets.events.map((e) => ({ value: e, label: e })),
  ];

  $: attemptOptions = [
    { value: "all", label: "All attempts" },
    ...facets.attempts.map((a) => ({ value: a, label: a })),
  ];

  $: sortKeyOptions = [
    { value: "ts", label: "Timestamp" },
    { value: "durationMs", label: "Duration" },
    { value: "tool", label: "Tool" },
    { value: "kind", label: "Kind" },
  ];

  $: pageSizeOptions = [50, 100, 200, 500, 1000].map((n) => ({
    value: String(n),
    label: String(n),
  }));

  $: selectedTags = selectedKey ? tagsByKey[selectedKey] || [] : [];
  $: selectedNote = selectedKey ? notesByKey[selectedKey] || "" : "";

  let newTag = "";
  let importTagsInput;
  let activeTab = "tags";

  function subagentLabel(e) {
    return e?.data?.agentType || e?.data?.agentId || e?.subagentType || "lead";
  }

  function shortAttemptLabel(attemptKey) {
    if (!attemptKey) return "";
    const marker = "::attempt:";
    const idx = attemptKey.indexOf(marker);
    if (idx === -1) return attemptKey;
    const number = attemptKey.slice(idx + marker.length);
    return `attempt ${number}`;
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
    taskRunStatusFilter ||
    taskRunRunnerFilter ||
    taskRunQuery !== undefined ||
    taskRunCanonicalOutcomeFilter ||
    taskRunFailureModeFilter ||
    taskRunFailureSubtypeFilter ||
    taskRunHumanInterventionFilter ||
    taskRunNeedsLabelingOnly ||
    reliabilityTrendBucket ||
    reliabilityTrendWindowDays
  ) {
    loadTaskRuns();
  }
</script>

<div class="min-h-screen bg-background text-foreground p-4 md:p-6">
  <div class="max-w-[1800px] mx-auto space-y-4">
    {#if notice}
      <div class="rounded-xl border px-4 py-3 text-sm {notice.tone === 'error' ? 'border-red-300 bg-red-50 text-red-800' : notice.tone === 'success' ? 'border-green-300 bg-green-50 text-green-800' : 'border-blue-300 bg-blue-50 text-blue-800'}">
        {notice.message}
      </div>
    {/if}

    <!-- Header -->
    <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div>
        <div class="flex items-center gap-3">
          <div class="text-xl md:text-2xl font-semibold">Suboculo</div>
          {#if sseConnected}
            <Badge variant="outline" class="bg-green-500/10 text-green-500 border-green-500/20">
              ● Live
            </Badge>
          {:else}
            <Badge variant="outline" class="bg-gray-500/10 text-gray-500 border-gray-500/20">
              ○ Offline
            </Badge>
          {/if}
        </div>
        <div class="text-sm text-muted-foreground">
          Real-time monitoring for AI coding agents.
        </div>
      </div>

      <div class="flex flex-wrap gap-2 items-center">
        <Button variant="secondary" on:click={exportTagsData} class="gap-2">
          <Download class="w-4 h-4" /> Export tags
        </Button>

        <input
          bind:this={importTagsInput}
          type="file"
          accept=".json,application/json"
          class="hidden"
          on:change={importTagsData}
        />
        <Button variant="secondary" on:click={() => importTagsInput?.click()} class="gap-2">
          <Upload class="w-4 h-4" /> Import tags
        </Button>

        <Button variant="destructive" on:click={clearAllTags} class="gap-2">
          <Trash2 class="w-4 h-4" /> Clear tags
        </Button>
      </div>
    </div>

    <!-- Main Tab Navigation -->
    <Tabs bind:value={mainTab}>
      <TabsList class="w-full md:w-auto">
        <TabsTrigger value="events" class="gap-2">
          <Search class="w-4 h-4" /> Events
        </TabsTrigger>
        <TabsTrigger value="task-runs" class="gap-2">
          <FileText class="w-4 h-4" /> Task Runs
          {#if taskRunsTotal > 0}
            <Badge variant="secondary" class="ml-1 text-xs">{taskRunsTotal}</Badge>
          {/if}
        </TabsTrigger>
        <TabsTrigger value="analyses" class="gap-2">
          <Sparkles class="w-4 h-4" /> Analyses
          {#if analyses.length > 0}
            <Badge variant="secondary" class="ml-1 text-xs">{analyses.length}</Badge>
          {/if}
        </TabsTrigger>
      </TabsList>

      <!-- Events Tab Content -->
      <TabsContent value="events">
    <!-- Filters Card -->
    <Card class="rounded-2xl shadow-sm">
      <CardContent class="p-4 md:p-5 space-y-4">
        <div class="flex flex-wrap gap-2">
          <Badge variant="secondary">Total: {stats.total}</Badge>
          <Badge variant="secondary">Filtered: {totalEntries}</Badge>
          {#if stats.avgDur != null}
            <Badge variant="secondary">Avg duration: {stats.avgDur}ms</Badge>
          {/if}
        </div>

        <Separator />

        <div class="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div class="md:col-span-3 space-y-1">
            <Label>Search</Label>
            <div class="relative">
              <Search class="w-4 h-4 absolute left-3 top-2.5 text-muted-foreground" />
              <Input
                bind:value={query}
                placeholder="Search tool, kind, session, callID, tags, notes..."
                class="pl-9"
              />
            </div>
          </div>

          <div class="md:col-span-2 space-y-1">
            <Label>Runner</Label>
            <Select bind:value={runner} options={runnerOptions} />
          </div>

          <div class="md:col-span-2 space-y-1">
            <Label>Event</Label>
            <Select bind:value={event} options={eventOptions} />
          </div>

          <div class="md:col-span-2 space-y-1">
            <Label>Tool</Label>
            <Select bind:value={tool} options={toolOptions} />
          </div>

          <div class="md:col-span-2 space-y-1">
            <Label>Subagent</Label>
            <Select bind:value={subagent} options={subagentOptions} />
          </div>

          <div class="md:col-span-1 space-y-1">
            <Label>Tag</Label>
            <Select bind:value={tagFilter} options={tagFilterOptions} />
          </div>
          <div class="md:col-span-2 space-y-1">
            <Label>Attempt</Label>
            <Select bind:value={attempt} options={attemptOptions} />
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div class="md:col-span-2 space-y-1">
            <Label>Kind (legacy)</Label>
            <Select bind:value={kind} options={kindOptions} />
          </div>

          <div class="md:col-span-2 space-y-1">
            <Label>Type (legacy)</Label>
            <Select bind:value={type} options={typeOptions} />
          </div>

          <div class="md:col-span-2 space-y-1">
            <Label>Root session</Label>
            <Select bind:value={rootSession} options={rootSessionOptions} />
          </div>

          <div class="md:col-span-4 space-y-1">
            <Label>Sort</Label>
            <div class="flex gap-2">
              <Select bind:value={sortKey} options={sortKeyOptions} />
              <Button
                variant="secondary"
                on:click={() => (sortDir = sortDir === "asc" ? "desc" : "asc")}
                class="gap-2"
                title="Toggle sort direction"
              >
                <ArrowUpDown class="w-4 h-4" />
                {sortDir.toUpperCase()}
              </Button>
            </div>
          </div>

          <div class="md:col-span-4 space-y-1">
            <Label>Page size</Label>
            <Select
              value={String(pageSize)}
              options={pageSizeOptions}
              on:change={(e) => {
                pageSize = Number(e.target.value);
                page = 1;
              }}
            />
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- Main Content -->
    <div class="grid grid-cols-1 xl:grid-cols-[1fr_500px] gap-4">
      <!-- Entries List -->
      <Card class="rounded-2xl shadow-sm">
        <CardContent class="p-0">
          <div class="flex items-center justify-between p-4 bg-muted/5">
            <div class="text-base font-semibold">
              Entries {isLoading ? "(loading...)" : ""}
            </div>
            <div class="text-sm text-muted-foreground font-medium">
              Page <span class="text-foreground">{page}</span> / <span class="text-foreground">{totalPages}</span>
            </div>
          </div>
          <Separator />

          <!-- Selection Toolbar -->
          <div class="flex items-center justify-between p-3 bg-muted/30 border-b">
            <div class="flex items-center gap-2 flex-wrap">
              {#if selectedEntries.size > 0}
                <span class="text-sm font-semibold text-blue-900">
                  {selectedEntries.size} selected
                </span>
                <Button variant="outline" size="sm" on:click={clearSelection}>
                  Clear
                </Button>
              {:else}
                <span class="text-sm text-muted-foreground">Quick select:</span>
              {/if}
              <Button variant="outline" size="sm" on:click={() => selectFirst(10)}>
                First 10
              </Button>
              <Button variant="outline" size="sm" on:click={() => selectFirst(25)}>
                First 25
              </Button>
              <Button variant="outline" size="sm" on:click={() => selectFirst(50)}>
                First 50
              </Button>
              <Button variant="outline" size="sm" on:click={selectAllVisible}>
                All ({pageItems.length})
              </Button>
              <span class="text-xs text-muted-foreground ml-2">
                💡 Tip: Shift+click to select range
              </span>
            </div>
            {#if selectedEntries.size > 0}
              <div class="flex items-center gap-2">
                <Button variant="outline" size="sm" class="gap-2" on:click={sendSelectionToCLI} disabled={sendToCliLoading}>
                  {#if sendToCliLoading}
                    <span class="animate-spin">⏳</span> Sending...
                  {:else}
                    <span>↗</span> Send to CLI
                  {/if}
                </Button>
                <Button variant="default" size="sm" class="gap-2" on:click={analyzeSelection}>
                  <span>🔍</span> Analyze
                </Button>
              </div>
            {/if}
            {#if sendToCliMessage}
              <div class="text-xs px-3 py-1.5 rounded-full {sendToCliMessage.startsWith('Error') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}">
                {sendToCliMessage}
              </div>
            {/if}
          </div>

          <div class="max-h-[70vh] overflow-auto">
            <table class="w-full text-sm">
              <thead class="sticky top-0 bg-background z-10 border-b-2">
                <tr class="text-left">
                  <th class="px-4 py-3 w-12">
                    <input
                      type="checkbox"
                      class="w-4 h-4 cursor-pointer rounded border-gray-300"
                      checked={selectedEntries.size === pageItems.length && pageItems.length > 0}
                      on:change={(e) => e.target.checked ? selectAllVisible() : clearSelection()}
                    />
                  </th>
                  <th class="px-4 py-3 font-semibold text-muted-foreground uppercase text-xs tracking-wide">Time</th>
                  <th class="px-4 py-3 font-semibold text-muted-foreground uppercase text-xs tracking-wide">Runner</th>
                  <th class="px-4 py-3 font-semibold text-muted-foreground uppercase text-xs tracking-wide">Event</th>
                  <th class="px-4 py-3 font-semibold text-muted-foreground uppercase text-xs tracking-wide">Tool</th>
                  <th class="px-4 py-3 font-semibold text-muted-foreground uppercase text-xs tracking-wide">Agent</th>
                  <th class="px-4 py-3 font-semibold text-muted-foreground uppercase text-xs tracking-wide">Status</th>
                  <th class="px-4 py-3 font-semibold text-muted-foreground uppercase text-xs tracking-wide">Duration</th>
                  <th class="px-4 py-3 font-semibold text-muted-foreground uppercase text-xs tracking-wide">Tokens</th>
                  <th class="px-4 py-3 font-semibold text-muted-foreground uppercase text-xs tracking-wide">Tags</th>
                </tr>
              </thead>
              <tbody>
                {#each pageItems as e, idx (e.__key)}
                  {@const key = e.__key}
                  {@const isSel = selectedKey === key}
                  {@const isChecked = selectedEntries.has(key)}
                  {@const tags = tagsByKey[key] || []}
                  {@const durationMs = e.data?.durationMs}
                  {@const dur = typeof durationMs === "number" ? (durationMs === 0 ? "<1ms" : `${durationMs}ms`) : ""}
                  {@const cepEvent = e.event || ""}
                  {@const cepRunner = e.runner || "unknown"}
                  {@const cepStatus = e.data?.status || ""}
                  {@const tool = e.data?.tool || ""}
                  {@const isUsageEvent = cepEvent === "usage"}
                  {@const embeddedUsage = e.data?.response?.usage}
                  {@const hasFlatTokens = e.data?.inputTokens != null || e.data?.outputTokens != null}
                  {@const hasUsage = isUsageEvent || hasFlatTokens || embeddedUsage}
                  {@const usageModel = isUsageEvent ? e.data?.model : null}
                  {@const usageAgentLabel = e.data?.agentType || e.data?.agentId || "lead"}
                  {@const usageTokens = (isUsageEvent || hasFlatTokens) ? {
                    input: e.data?.inputTokens || 0,
                    output: e.data?.outputTokens || 0,
                    cacheCreate: e.data?.cacheCreationTokens || 0,
                    cacheRead: e.data?.cacheReadTokens || 0
                  } : embeddedUsage ? {
                    input: embeddedUsage.input_tokens || 0,
                    output: embeddedUsage.output_tokens || 0,
                    cacheCreate: embeddedUsage.cache_creation_input_tokens || 0,
                    cacheRead: embeddedUsage.cache_read_input_tokens || 0
                  } : null}
                  <tr
                    class="group cursor-pointer transition-all duration-150 {isChecked
                      ? 'bg-blue-100/50 border-l-4 border-l-blue-500'
                      : isSel
                      ? 'bg-blue-50 border-l-4 border-l-blue-300'
                      : isUsageEvent
                      ? 'bg-amber-50/60 hover:bg-amber-100/60 border-l-4 border-l-amber-300'
                      : idx % 2 === 0 ? 'bg-background hover:bg-muted/30' : 'bg-muted/10 hover:bg-muted/40'}"
                  >
                    <td class="px-4 py-3" on:click|stopPropagation>
                      <input
                        type="checkbox"
                        class="w-4 h-4 cursor-pointer rounded border-gray-300"
                        checked={isChecked}
                        on:click={(e) => toggleSelection(key, idx, e.shiftKey)}
                      />
                    </td>
                    <td class="px-4 py-3 whitespace-nowrap text-xs" on:click={() => selectEntry(key)}>{formatTs(e.ts)}</td>
                    <td class="px-4 py-3" on:click={() => selectEntry(key)}>
                      <Badge variant="outline" class="rounded-full text-xs font-medium">
                        {cepRunner}
                      </Badge>
                    </td>
                    <td class="px-4 py-3" on:click={() => selectEntry(key)}>
                      <Badge variant={isUsageEvent ? "outline" : "secondary"} class="rounded-full text-xs font-medium {isUsageEvent ? 'border-amber-400 text-amber-800 bg-amber-100/70' : ''}">
                        {cepEvent}
                      </Badge>
                    </td>
                    <td class="px-4 py-3 font-mono text-xs font-semibold" on:click={() => selectEntry(key)}>
                      {#if isUsageEvent}
                        <div class="space-y-1">
                          <Badge variant="outline" class="rounded-full text-xs border-amber-400 text-amber-900 bg-amber-100/70">{usageModel || "unknown"}</Badge>
                          <div class="text-[10px] uppercase tracking-wide text-amber-800">token telemetry</div>
                        </div>
                      {:else}
                        <div class="space-y-1">
                          <div>{tool || "—"}</div>
                          {#if e.attemptKey}
                            <div title={e.attemptKey}>
                              <Badge variant="outline" class="rounded-full text-[10px] px-2 py-0">
                                {shortAttemptLabel(e.attemptKey)}
                              </Badge>
                            </div>
                          {/if}
                        </div>
                      {/if}
                    </td>
                    <td class="px-4 py-3 text-xs" on:click={() => selectEntry(key)}>
                      {#if e.data?.agentType || e.data?.agentId || isUsageEvent}
                        <Badge
                          variant="outline"
                          class="rounded-full text-xs {isUsageEvent ? 'border-amber-300 text-amber-900 bg-amber-50' : ''}"
                          title={e.data?.agentId || ''}
                        >
                          {usageAgentLabel}
                        </Badge>
                      {:else}
                        <span class="text-muted-foreground">lead</span>
                      {/if}
                    </td>
                    <td class="px-4 py-3 text-xs" on:click={() => selectEntry(key)}>
                      {#if isUsageEvent}
                        <span class="text-[10px] uppercase tracking-wide text-amber-800">metering</span>
                      {:else if cepStatus === 'success'}
                        <Badge variant="outline" class="rounded-full text-green-600 border-green-600">✓</Badge>
                      {:else if cepStatus === 'error'}
                        <Badge variant="outline" class="rounded-full text-red-600 border-red-600">✗</Badge>
                      {:else if cepStatus === 'timeout'}
                        <Badge variant="outline" class="rounded-full text-orange-600 border-orange-600">⏱</Badge>
                      {:else}
                        <span class="text-muted-foreground">—</span>
                      {/if}
                    </td>
                    <td class="px-4 py-3 text-xs font-medium {typeof durationMs === 'number' && durationMs > 1000 ? 'text-orange-600' : ''}" on:click={() => selectEntry(key)}>
                      {dur}
                    </td>
                    <td class="px-4 py-3 text-xs font-medium" on:click={() => selectEntry(key)}>
                      {#if hasUsage && usageTokens}
                        <div class="text-xs space-y-0.5 {isUsageEvent ? 'text-amber-950' : ''}">
                          <div>{isUsageEvent ? 'out' : 'out'}: {usageTokens.output.toLocaleString()}</div>
                          <div class="text-[10px] {isUsageEvent ? 'text-amber-800' : 'text-muted-foreground'}">
                            in: {usageTokens.input.toLocaleString()} · cache: {usageTokens.cacheRead.toLocaleString()}
                          </div>
                        </div>
                      {:else}
                        <span class="text-muted-foreground">—</span>
                      {/if}
                    </td>
                    <td class="px-4 py-3" on:click={() => selectEntry(key)}>
                      <div class="flex flex-wrap gap-1">
                        {#each tags.slice(0, 3) as t}
                          <Badge variant="outline" class="rounded-full">
                            {t}
                          </Badge>
                        {/each}
                        {#if tags.length > 3}
                          <Badge variant="outline" class="rounded-full">
                            +{tags.length - 3}
                          </Badge>
                        {/if}
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>

          <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3 p-4 border-t bg-muted/5">
            <div class="text-sm text-muted-foreground font-medium">
              Showing <span class="text-foreground">{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, totalEntries)}</span> of <span class="text-foreground">{totalEntries}</span>
            </div>
            <div class="flex gap-2">
              <Button variant="outline" on:click={() => (page = 1)} disabled={page === 1} class="font-medium">
                First
              </Button>
              <Button
                variant="outline"
                on:click={() => (page = Math.max(1, page - 1))}
                disabled={page === 1}
                class="font-medium"
              >
                ← Prev
              </Button>
              <Button
                variant="outline"
                on:click={() => (page = Math.min(totalPages, page + 1))}
                disabled={page === totalPages}
                class="font-medium"
              >
                Next →
              </Button>
              <Button
                variant="outline"
                on:click={() => (page = totalPages)}
                disabled={page === totalPages}
                class="font-medium"
              >
                Last
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Details Panel -->
      <Card class="rounded-2xl shadow-sm">
        <CardContent class="p-4 space-y-4">
          <div class="flex items-start justify-between gap-2 pb-2">
            <div>
              <div class="text-base font-semibold">Details</div>
              <div class="text-xs text-muted-foreground break-all font-mono mt-1">
                {selected ? selected.__key : "Select an entry"}
              </div>
            </div>
            {#if selected}
              <Button variant="ghost" on:click={() => { selectedKey = null; selected = null; }} class="h-8 w-8 p-0">
                <X class="w-4 h-4" />
              </Button>
            {/if}
          </div>

          {#if selected}
            <div class="space-y-2">
              <div class="flex flex-wrap gap-2">
                <Badge variant="secondary" class="rounded-full">{selected.event || "unknown"}</Badge>
                <Badge variant="outline" class="rounded-full">{selected.runner || "unknown"}</Badge>
                {#if selected.data?.tool}
                  <Badge variant="outline" class="rounded-full font-mono text-xs"
                    >{selected.data.tool}</Badge
                  >
                {/if}
                {#if selected.data?.status}
                  {#if selected.data.status === 'success'}
                    <Badge variant="outline" class="rounded-full text-green-600 border-green-600">✓ success</Badge>
                  {:else if selected.data.status === 'error'}
                    <Badge variant="outline" class="rounded-full text-red-600 border-red-600">✗ error</Badge>
                  {:else if selected.data.status === 'timeout'}
                    <Badge variant="outline" class="rounded-full text-orange-600 border-orange-600">⏱ timeout</Badge>
                  {:else}
                    <Badge variant="outline" class="rounded-full">{selected.data.status}</Badge>
                  {/if}
                {/if}
              </div>

              <div class="text-xs text-muted-foreground space-y-1">
                {#if selected.ts}
                  <div><span class="font-medium">Time:</span> {formatTs(selected.ts)}</div>
                {/if}
                {#if selected.sessionId}
                  <div class="break-all">
                    <span class="font-medium">Session:</span>
                    {selected.sessionId}
                  </div>
                {/if}
                {#if selected.traceId}
                  <div class="break-all">
                    <span class="font-medium">Trace:</span>
                    {selected.traceId}
                  </div>
                {/if}
                {#if selected.parentSessionId}
                  <div class="break-all">
                    <span class="font-medium">Parent Session:</span>
                    {selected.parentSessionId}
                  </div>
                {/if}
                {#if typeof selected.data?.durationMs === "number"}
                  <div><span class="font-medium">Duration:</span> {selected.data.durationMs === 0 ? "<1ms" : `${selected.data.durationMs}ms`}</div>
                {/if}
              </div>


              {#if selected.event === "usage" || selected.data?.inputTokens != null || selected.data?.outputTokens != null || selected.data?.response?.usage}
                {@const detailEmbeddedUsage = selected.data?.response?.usage}
                {@const detailUseFlatTokens = selected.event === "usage" || selected.data?.inputTokens != null || selected.data?.outputTokens != null}
                {@const detailInputTokens = detailUseFlatTokens ? (selected.data?.inputTokens || 0) : (detailEmbeddedUsage?.input_tokens || 0)}
                {@const detailOutputTokens = detailUseFlatTokens ? (selected.data?.outputTokens || 0) : (detailEmbeddedUsage?.output_tokens || 0)}
                {@const detailCacheCreate = detailUseFlatTokens ? (selected.data?.cacheCreationTokens || 0) : (detailEmbeddedUsage?.cache_creation_input_tokens || 0)}
                {@const detailCacheRead = detailUseFlatTokens ? (selected.data?.cacheReadTokens || 0) : (detailEmbeddedUsage?.cache_read_input_tokens || 0)}
                {@const totalInput = detailInputTokens + detailCacheCreate + detailCacheRead}
                {@const cacheHitRatio = totalInput > 0 ? (detailCacheRead / totalInput * 100).toFixed(1) : '0.0'}
                <div class="text-xs text-muted-foreground mt-3 pt-3 border-t border-border space-y-1">
                  <div class="font-semibold text-foreground">Token Usage</div>
                  {#if selected.data?.model}
                    <div><span class="font-medium">Model:</span> {selected.data.model}</div>
                  {/if}
                  {#if selected.data?.agentType || selected.data?.agentId}
                    <div><span class="font-medium">Agent:</span> {selected.data.agentType || selected.data.agentId}</div>
                  {/if}
                  <div><span class="font-medium">Input tokens:</span> {detailInputTokens.toLocaleString()}</div>
                  <div><span class="font-medium">Output tokens:</span> {detailOutputTokens.toLocaleString()}</div>
                  <div><span class="font-medium">Cache creation:</span> {detailCacheCreate.toLocaleString()}</div>
                  <div><span class="font-medium">Cache read:</span> {detailCacheRead.toLocaleString()}</div>
                  <div><span class="font-medium">Total input:</span> {totalInput.toLocaleString()}</div>
                  <div><span class="font-medium">Cache hit ratio:</span> {cacheHitRatio}%</div>
                </div>
              {/if}
            </div>

            <Separator />

            <Tabs value={activeTab}>
              <TabsList class="w-full">
                <TabsTrigger value="tags" class="flex-1">Tags</TabsTrigger>
                <TabsTrigger value="notes" class="flex-1">Notes</TabsTrigger>
                <TabsTrigger value="json" class="flex-1">JSON</TabsTrigger>
              </TabsList>

              <TabsContent value="tags" class="space-y-3">
                <div class="flex gap-2">
                  <Input
                    bind:value={newTag}
                    placeholder="Add tag (e.g. bug, perf, secret, flaky)"
                    on:keydown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTagToEntry(selected.__key, newTag);
                        newTag = "";
                      }
                    }}
                  />
                  <Button
                    on:click={() => {
                      addTagToEntry(selected.__key, newTag);
                      newTag = "";
                    }}
                    class="gap-2"
                  >
                    <Tag class="w-4 h-4" /> Add
                  </Button>
                </div>

                <div class="flex flex-wrap gap-2">
                  {#if selectedTags.length}
                    {#each selectedTags as t}
                      <Badge variant="outline" class="rounded-full flex items-center gap-2">
                        {t}
                        <button
                          class="text-muted-foreground hover:text-foreground"
                          on:click={(e) => {
                            e.stopPropagation();
                            removeTagFromEntry(selected.__key, t);
                          }}
                          title="Remove tag"
                        >
                          <X class="w-3 h-3" />
                        </button>
                      </Badge>
                    {/each}
                  {:else}
                    <div class="text-sm text-muted-foreground">No tags yet.</div>
                  {/if}
                </div>
              </TabsContent>

              <TabsContent value="notes" class="space-y-2">
                <Label>Notes</Label>
                <Textarea
                  value={selectedNote}
                  on:input={(e) => setNoteForEntry(selected.__key, e.target.value)}
                  placeholder="Write a short note about this entry..."
                  class="min-h-[160px]"
                />
                <div class="text-xs text-muted-foreground">
                  Notes are stored in the database.
                </div>
              </TabsContent>

              <TabsContent value="json" class="space-y-2">
                <Label>Raw entry</Label>
                <pre
                  class="text-xs bg-muted/30 rounded-xl p-4 overflow-auto max-h-[75vh] whitespace-pre-wrap break-words font-mono leading-relaxed">{JSON.stringify(
                    selected,
                    null,
                    2
                  )}</pre>
              </TabsContent>
            </Tabs>
          {:else}
            <div class="text-sm text-muted-foreground">
              Click an entry to see details.
            </div>
          {/if}
        </CardContent>
      </Card>
    </div>
      </TabsContent>

      <TabsContent value="task-runs">
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
                  <Button variant="ghost" on:click={() => selectedTaskRun = null} class="h-8 w-8 p-0">
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
      </TabsContent>

      <!-- Analyses Tab Content -->
      <TabsContent value="analyses">
        <Card class="rounded-2xl shadow-sm">
          <CardContent class="p-4 md:p-5 space-y-4">
            <div class="flex items-center justify-between">
              <h2 class="text-lg font-semibold">Analysis History</h2>
              <Button variant="outline" size="sm" on:click={loadAnalyses} disabled={loadingAnalyses}>
                {loadingAnalyses ? 'Loading...' : 'Refresh'}
              </Button>
            </div>

            <Separator />

            {#if loadingAnalyses}
              <div class="text-center text-muted-foreground py-8">
                Loading analyses...
              </div>
            {:else if analyses.length === 0}
              <div class="text-center text-muted-foreground py-8">
                No analyses yet. Run an analysis from the Events tab to see results here.
              </div>
            {:else}
              <div class="space-y-3">
                {#each analyses as analysis (analysis.id)}
                  <Card class="hover:shadow-md transition-shadow">
                    <CardContent class="p-4">
                      <div class="flex items-start justify-between gap-4">
                        <div class="flex-1 space-y-2">
                          <div class="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline">{analysis.model}</Badge>
                            <Badge variant="secondary">{analysis.event_count} events</Badge>
                            <span class="text-sm text-muted-foreground">
                              {new Date(analysis.timestamp).toLocaleString()}
                            </span>
                          </div>
                          <div class="text-sm text-muted-foreground line-clamp-2">
                            {analysis.analysis.substring(0, 200)}...
                          </div>
                        </div>
                        <div class="flex gap-2 flex-shrink-0">
                          <Button variant="outline" size="sm" on:click={() => viewAnalysis(analysis.id)} class="gap-1">
                            <Eye class="w-4 h-4" /> View
                          </Button>
                          <Button variant="outline" size="sm" on:click={() => exportAnalysisAsMarkdown(analysis)} class="gap-1">
                            <FileText class="w-4 h-4" /> Export
                          </Button>
                          <Button variant="destructive" size="sm" on:click={() => deleteAnalysisById(analysis.id)}>
                            <Trash2 class="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                {/each}
              </div>
            {/if}
          </CardContent>
        </Card>

        <!-- Analysis Detail View -->
        {#if selectedAnalysis}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" on:click={() => selectedAnalysis = null} on:keydown={(e) => e.key === 'Escape' && (selectedAnalysis = null)}>
            <div role="dialog" aria-modal="true" aria-label="Analysis Details" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
              <Card class="w-full max-w-3xl max-h-[90vh] overflow-hidden">
                <CardContent class="p-6 space-y-4 overflow-y-auto max-h-[90vh]">
                  <div class="flex items-start justify-between gap-4">
                    <h2 class="text-xl font-semibold">Analysis Details</h2>
                    <Button variant="ghost" size="sm" on:click={() => selectedAnalysis = null}>
                      <X class="w-4 h-4" />
                    </Button>
                  </div>

                  <Separator />

                  <div class="space-y-3">
                    <div class="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <div class="text-muted-foreground">Date</div>
                        <div class="font-medium">{new Date(selectedAnalysis.timestamp).toLocaleString()}</div>
                      </div>
                      <div>
                        <div class="text-muted-foreground">Model</div>
                        <div class="font-medium">{selectedAnalysis.model}</div>
                      </div>
                      <div>
                        <div class="text-muted-foreground">Events Analyzed</div>
                        <div class="font-medium">{selectedAnalysis.event_count}</div>
                      </div>
                      {#if selectedAnalysis.prompt}
                        <div class="col-span-2">
                          <div class="text-muted-foreground">Custom Prompt</div>
                          <div class="font-medium text-sm bg-muted p-2 rounded mt-1">{selectedAnalysis.prompt}</div>
                        </div>
                      {/if}
                    </div>

                    <Separator />

                    <div>
                      <div class="text-sm text-muted-foreground mb-2">Analysis</div>
                      <div class="prose prose-sm max-w-none bg-muted p-4 rounded">
                        {@html DOMPurify.sanitize(marked(selectedAnalysis.analysis))}
                      </div>
                    </div>
                  </div>

                  <Separator />

                  <div class="flex gap-2 justify-end">
                    <Button variant="outline" on:click={() => exportAnalysisAsMarkdown(selectedAnalysis)} class="gap-2">
                      <FileText class="w-4 h-4" /> Export as Markdown
                    </Button>
                    <Button variant="default" on:click={() => selectedAnalysis = null}>
                      Close
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        {/if}
      </TabsContent>
    </Tabs>

    <!-- LLM Analysis Dialog -->
    {#if showAnalysisDialog}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" on:click={closeAnalysisDialog} on:keydown={(e) => e.key === 'Escape' && closeAnalysisDialog()}>
        <div role="dialog" aria-modal="true" aria-label="Analyze Events" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
          <Card class="w-full max-w-3xl max-h-[90vh] overflow-hidden">
            <CardContent class="p-6 space-y-4 overflow-y-auto max-h-[90vh]">
            <div class="flex items-center justify-between">
              <h2 class="text-2xl font-bold">🔍 Analyze {selectedEntries.size} Events</h2>
              <Button variant="ghost" size="sm" on:click={closeAnalysisDialog}>
                <X class="w-4 h-4" />
              </Button>
            </div>

            {#if !analysisResult}
              <!-- Configuration Form -->
              <div class="space-y-4">
                <div class="space-y-2">
                  <Label for="apiKey">Anthropic API Key</Label>
                  <Input
                    id="apiKey"
                    type="password"
                    placeholder="sk-ant-..."
                    bind:value={apiKey}
                    class="font-mono text-sm"
                  />
                  <p class="text-xs text-muted-foreground">
                    Get your API key at <a href="https://console.anthropic.com/" target="_blank" class="text-blue-600 hover:underline">console.anthropic.com</a>
                    • Already a Claude user? API access is available!
                  </p>
                </div>

                <div class="space-y-2">
                  <Label for="model">Claude Model</Label>
                  <select
                    id="model"
                    bind:value={selectedModel}
                    class="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <optgroup label="Latest Models (Recommended)">
                      <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (Default - Best speed/intelligence)</option>
                      <option value="claude-opus-4-6">Claude Opus 4.6 (Most intelligent)</option>
                      <option value="claude-haiku-4-5">Claude Haiku 4.5 (Fastest & cheapest)</option>
                    </optgroup>
                    <optgroup label="Legacy Models">
                      <option value="claude-sonnet-4-5">Claude Sonnet 4.5</option>
                      <option value="claude-opus-4-5">Claude Opus 4.5</option>
                    </optgroup>
                  </select>
                </div>

                <div class="space-y-2">
                  <Label for="prompt">Custom Prompt (Optional)</Label>
                  <Textarea
                    id="prompt"
                    bind:value={customPrompt}
                    placeholder="Leave empty for default analysis prompt..."
                    rows="4"
                    class="text-sm"
                  />
                </div>

                {#if analysisError}
                  <div class="p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
                    <strong>Error:</strong> {analysisError}
                  </div>
                {/if}

                <div class="flex gap-2">
                  <Button
                    variant="default"
                    on:click={runAnalysis}
                    disabled={analysisLoading || !apiKey.trim()}
                    class="flex-1"
                  >
                    {#if analysisLoading}
                      <span class="animate-spin mr-2">⏳</span> Analyzing...
                    {:else}
                      Analyze
                    {/if}
                  </Button>
                  <Button variant="outline" on:click={closeAnalysisDialog}>
                    Cancel
                  </Button>
                </div>
              </div>
            {:else}
              <!-- Analysis Results -->
              <div class="space-y-4">
                <div class="flex items-center gap-2 text-sm text-muted-foreground">
                  <Badge variant="outline">Anthropic API</Badge>
                  <Badge variant="outline">{analysisResult.model}</Badge>
                  <Badge variant="outline">{analysisResult.eventCount} events</Badge>
                </div>

                <Separator />

                <div class="prose prose-sm max-w-none bg-muted/30 rounded-lg p-4 text-sm leading-relaxed">
                  {@html DOMPurify.sanitize(marked(analysisResult.analysis))}
                </div>

                <div class="flex gap-2">
                  <Button variant="outline" on:click={saveAnalysisAsMarkdown} class="gap-2">
                    <span>💾</span> Save as Markdown
                  </Button>
                  <Button variant="outline" on:click={() => {
                    analysisResult = null;
                    analysisError = null;
                  }}>
                    Analyze Again
                  </Button>
                  <Button variant="default" on:click={closeAnalysisDialog}>
                    Done
                  </Button>
                </div>
              </div>
            {/if}
          </CardContent>
        </Card>
        </div>
      </div>
    {/if}

    {#if confirmDialog}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" on:click={closeConfirmDialog} on:keydown={(e) => e.key === 'Escape' && closeConfirmDialog()}>
        <div role="dialog" aria-modal="true" aria-label="Confirm Action" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
          <Card class="w-full max-w-md">
            <CardContent class="p-6 space-y-4">
              <div class="text-lg font-semibold">Confirm Action</div>
              <div class="text-sm text-muted-foreground">{confirmDialog.message}</div>
              <div class="flex justify-end gap-2">
                <Button variant="outline" on:click={closeConfirmDialog}>Cancel</Button>
                <Button variant="destructive" on:click={confirmDialogAccept}>Confirm</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    {/if}
  </div>
</div>
