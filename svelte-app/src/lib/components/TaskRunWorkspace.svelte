<script>
  import TaskRunListPanel from "./TaskRunListPanel.svelte";
  import TaskRunDetailPanel from "./TaskRunDetailPanel.svelte";

  export let loadingTaskRuns = false;
  export let taskRuns = [];
  export let taskRunsTotal = 0;
  export let selectedTaskRun = null;
  export let selectedTaskRunIds = new Set();
  export let savingBulkOutcomes = false;
  export let bulkTaskRunOutcome = null;
  export let evaluationTypeOptions = [];
  export let outcomeLabelOptions = [];
  export let failureModeOptions = [];
  export let taskRunAfterActionReport = null;
  export let loadingTaskRunAfterActionReport = false;
  export let taskRunOutcome = null;
  export let outcomeLabelHelp = {};
  export let shouldShowFailureFields = false;
  export let requiresFailureMode = false;
  export let failureSubtypeOptions = [];

  export let onSelectAllVisibleTaskRuns = () => {};
  export let onClearSelectedTaskRuns = () => {};
  export let onBulkOutcomeLabelChange = () => {};
  export let onBulkFailureModeChange = () => {};
  export let onApplyBulkTaskRunOutcome = () => {};
  export let onViewTaskRun = () => {};
  export let onToggleTaskRunSelection = () => {};
  export let onCloseTaskRunDetail = () => {};
  export let onGenerateTaskRunAfterActionReport = () => {};
  export let onCopyTaskRunAfterActionReportMarkdown = () => {};
  export let onHandleOutcomeLabelChange = () => {};
  export let onHandleFailureModeChange = () => {};
  export let onSaveTaskRunOutcome = () => {};
  export let onResetOutcomeForm = () => {};
</script>

<div class="grid grid-cols-1 xl:grid-cols-[1fr_520px] gap-4">
  <TaskRunListPanel
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
    {onSelectAllVisibleTaskRuns}
    {onClearSelectedTaskRuns}
    {onBulkOutcomeLabelChange}
    {onBulkFailureModeChange}
    {onApplyBulkTaskRunOutcome}
    {onViewTaskRun}
    {onToggleTaskRunSelection}
  />

  <TaskRunDetailPanel
    {selectedTaskRun}
    {taskRunAfterActionReport}
    {loadingTaskRunAfterActionReport}
    bind:taskRunOutcome
    {evaluationTypeOptions}
    {outcomeLabelOptions}
    {failureModeOptions}
    {failureSubtypeOptions}
    {outcomeLabelHelp}
    {shouldShowFailureFields}
    {requiresFailureMode}
    {onCloseTaskRunDetail}
    {onGenerateTaskRunAfterActionReport}
    {onCopyTaskRunAfterActionReportMarkdown}
    {onHandleOutcomeLabelChange}
    {onHandleFailureModeChange}
    {onSaveTaskRunOutcome}
    {onResetOutcomeForm}
  />
</div>
