async function writeClipboardText(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export async function viewTaskRunAction({
  id,
  api,
  onOpenTaskRun,
  taskRunAfterActionReportCache,
  setSelectedTaskRun,
  setTaskRunAfterActionReport,
  setTaskRunAarCache
}) {
  try {
    const nextTaskRun = await api.getTaskRun(id);
    setSelectedTaskRun(nextTaskRun);
    onOpenTaskRun(id);

    const cached = taskRunAfterActionReportCache.get(id) || null;
    setTaskRunAfterActionReport(cached);
    if (!cached) {
      try {
        const persisted = await api.getTaskRunAfterActionReport(id, { storedOnly: true });
        setTaskRunAfterActionReport(persisted);
        setTaskRunAarCache(id, persisted);
      } catch (reportErr) {
        // No persisted report yet is expected until user generates or outcome-save regenerates it.
        setTaskRunAfterActionReport(null);
      }
    }
  } catch (err) {
    console.error("Failed to load task run:", err);
    alert("Failed to load task run");
  }
}

export async function generateTaskRunAfterActionReportAction({
  selectedTaskRun,
  api,
  setLoadingTaskRunAfterActionReport,
  setTaskRunAfterActionReport,
  setTaskRunAarCache
}) {
  if (!selectedTaskRun?.id) return;
  try {
    setLoadingTaskRunAfterActionReport(true);
    const report = await api.getTaskRunAfterActionReport(selectedTaskRun.id);
    setTaskRunAfterActionReport(report);
    setTaskRunAarCache(selectedTaskRun.id, report);
  } catch (err) {
    console.error("Failed to generate after-action report:", err);
    alert("Failed to generate after-action report");
  } finally {
    setLoadingTaskRunAfterActionReport(false);
  }
}

export async function copyTaskRunAfterActionReportMarkdownAction({ report, showNotice }) {
  if (!report?.markdown) return;
  try {
    await writeClipboardText(report.markdown);
    showNotice("After-action report copied to clipboard", "success");
  } catch (err) {
    console.error("Failed to copy after-action report:", err);
    showNotice("Failed to copy after-action report", "error");
  }
}

export async function applyBulkTaskRunOutcomeAction({
  selectedTaskRunIds,
  bulkTaskRunOutcome,
  requiredFailureLabels,
  setSavingBulkOutcomes,
  api,
  showNotice,
  loadTaskRuns,
  selectedTaskRun,
  setSelectedTaskRun,
  clearSelectedTaskRuns
}) {
  if (selectedTaskRunIds.size === 0) {
    alert("Select at least one task run.");
    return;
  }

  const requiresFailure = requiredFailureLabels.includes(bulkTaskRunOutcome.outcome_label);
  if (requiresFailure && !bulkTaskRunOutcome.failure_mode) {
    alert("Failure mode is required for this outcome label.");
    return;
  }

  try {
    setSavingBulkOutcomes(true);
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
      setSelectedTaskRun(await api.getTaskRun(selectedTaskRun.id));
    }
    if (result.failure_count === 0) {
      clearSelectedTaskRuns();
    }
  } catch (err) {
    console.error("Failed to apply bulk outcomes:", err);
    alert("Failed to apply bulk outcomes");
  } finally {
    setSavingBulkOutcomes(false);
  }
}

export async function saveTaskRunOutcomeAction({
  selectedTaskRun,
  requiresFailureMode,
  taskRunOutcome,
  api,
  setSelectedTaskRun,
  deleteTaskRunAarCache,
  setLoadingTaskRunAfterActionReport,
  setTaskRunAfterActionReport,
  setTaskRunAarCache,
  loadTaskRuns,
  resetOutcomeForm
}) {
  if (!selectedTaskRun) return;
  if (requiresFailureMode && !taskRunOutcome.failure_mode) {
    alert("Failure mode is required for this outcome label.");
    return;
  }

  try {
    const taskRunId = selectedTaskRun.id;
    await api.createOutcome(taskRunId, {
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

    setSelectedTaskRun(await api.getTaskRun(taskRunId));
    deleteTaskRunAarCache(taskRunId);
    setLoadingTaskRunAfterActionReport(true);
    try {
      const updatedReport = await api.getTaskRunAfterActionReport(taskRunId);
      setTaskRunAfterActionReport(updatedReport);
      setTaskRunAarCache(taskRunId, updatedReport);
    } catch (reportErr) {
      console.error("Failed to regenerate after-action report:", reportErr);
      setTaskRunAfterActionReport(null);
    } finally {
      setLoadingTaskRunAfterActionReport(false);
    }
    await loadTaskRuns();
    resetOutcomeForm();
  } catch (err) {
    console.error("Failed to save outcome:", err);
    alert(err.message);
  }
}
