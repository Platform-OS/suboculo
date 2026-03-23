<script>
  import Card from "./ui/Card.svelte";
  import CardContent from "./ui/CardContent.svelte";
  import Button from "./ui/Button.svelte";
  import Badge from "./ui/Badge.svelte";
  import Select from "./ui/Select.svelte";
  import Separator from "./ui/Separator.svelte";
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

  export let onSelectAllVisibleTaskRuns = () => {};
  export let onClearSelectedTaskRuns = () => {};
  export let onBulkOutcomeLabelChange = () => {};
  export let onBulkFailureModeChange = () => {};
  export let onApplyBulkTaskRunOutcome = () => {};
  export let onViewTaskRun = () => {};
  export let onToggleTaskRunSelection = () => {};
</script>

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
