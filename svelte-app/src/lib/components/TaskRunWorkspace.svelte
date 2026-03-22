<script>
  import Card from "./ui/Card.svelte";
  import CardContent from "./ui/CardContent.svelte";
  import Button from "./ui/Button.svelte";
  import Badge from "./ui/Badge.svelte";
  import Label from "./ui/Label.svelte";
  import Select from "./ui/Select.svelte";
  import Input from "./ui/Input.svelte";
  import Textarea from "./ui/Textarea.svelte";
  import Separator from "./ui/Separator.svelte";
  import { X } from "lucide-svelte";
  import { formatTs } from "$lib/formatters.js";

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
            <Button variant="outline" size="sm" on:click={onSelectAllVisibleTaskRuns} disabled={taskRuns.length === 0}>Select visible</Button>
            <Button variant="outline" size="sm" on:click={onClearSelectedTaskRuns} disabled={selectedTaskRunIds.size === 0}>Clear</Button>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-12 gap-2">
          <div class="md:col-span-3">
            <Select bind:value={bulkTaskRunOutcome.evaluation_type} options={evaluationTypeOptions} />
          </div>
          <div class="md:col-span-3">
            <Select bind:value={bulkTaskRunOutcome.outcome_label} options={outcomeLabelOptions} on:change={onBulkOutcomeLabelChange} />
          </div>
          <div class="md:col-span-3">
            <Select bind:value={bulkTaskRunOutcome.failure_mode} options={failureModeOptions} on:change={onBulkFailureModeChange} />
          </div>
          <div class="md:col-span-3">
            <Button class="w-full" size="sm" on:click={onApplyBulkTaskRunOutcome} disabled={savingBulkOutcomes || selectedTaskRunIds.size === 0}>
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
              on:click={() => onViewTaskRun(run.id)}
            >
              <div class="flex items-start justify-between gap-4">
                <div class="space-y-2 min-w-0">
                  <div class="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedTaskRunIds.has(run.id)}
                      on:click|stopPropagation
                      on:change|stopPropagation={() => onToggleTaskRunSelection(run.id)}
                      class="w-4 h-4"
                    />
                    <span class="font-medium truncate">{run.title || run.task_key}</span>
                  </div>
                  <div class="text-xs text-muted-foreground font-mono break-all">{run.task_key}</div>
                  <div class="flex flex-wrap gap-2">
                    <Badge variant="outline">{run.runner || "unknown"}</Badge>
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
          <Button variant="ghost" on:click={onCloseTaskRunDetail} class="h-8 w-8 p-0">
            <X class="w-4 h-4" />
          </Button>
        {/if}
      </div>

      {#if selectedTaskRun}
        <div class="space-y-3">
          <div class="flex flex-wrap gap-2">
            <Badge variant="outline">{selectedTaskRun.runner || "unknown"}</Badge>
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
              <Button variant="outline" size="sm" on:click={onGenerateTaskRunAfterActionReport} disabled={loadingTaskRunAfterActionReport}>
                {loadingTaskRunAfterActionReport ? "Generating..." : "Generate report"}
              </Button>
              <Button variant="outline" size="sm" on:click={onCopyTaskRunAfterActionReportMarkdown} disabled={!taskRunAfterActionReport?.markdown}>
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
              <Select bind:value={taskRunOutcome.outcome_label} options={outcomeLabelOptions} on:change={onHandleOutcomeLabelChange} />
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
                <Select bind:value={taskRunOutcome.failure_mode} options={failureModeOptions} on:change={onHandleFailureModeChange} />
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
            <Button on:click={onSaveTaskRunOutcome}>Save outcome</Button>
            <Button variant="outline" on:click={onResetOutcomeForm}>Reset</Button>
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
