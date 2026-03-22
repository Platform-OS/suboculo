<script>
  import Card from "./ui/Card.svelte";
  import CardContent from "./ui/CardContent.svelte";
  import Button from "./ui/Button.svelte";
  import Input from "./ui/Input.svelte";
  import Label from "./ui/Label.svelte";
  import Select from "./ui/Select.svelte";
  import Separator from "./ui/Separator.svelte";

  export let loadingTaskRuns = false;

  export let taskRunQuery = "";
  export let taskRunStatusFilter = "all";
  export let taskRunRunnerFilter = "all";
  export let taskRunCanonicalOutcomeFilter = "all";
  export let taskRunFailureModeFilter = "all";
  export let taskRunFailureSubtypeFilter = "all";
  export let taskRunHumanInterventionFilter = "all";
  export let taskRunNeedsLabelingOnly = false;

  export let taskRunStatusOptions = [];
  export let taskRunRunnerOptions = [];
  export let taskRunCanonicalOutcomeOptions = [];
  export let taskRunFailureModeOptions = [];
  export let taskRunFailureSubtypeOptions = [];
  export let taskRunHumanInterventionOptions = [];

  export let onRefresh = () => {};
  export let onDeriveTaskRuns = () => {};
  export let onTaskRunCanonicalOutcomeFilterChange = () => {};
  export let onTaskRunFailureModeFilterChange = () => {};
  export let onNormalizeTaskRunFailureSubtypeFilter = () => {};
  export let onTaskRunHumanInterventionFilterChange = () => {};
  export let onToggleNoCanonicalFilter = () => {};
  export let onToggleRequiresHumanFilter = () => {};
  export let onToggleNeedsLabelingQueue = () => {};
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
        <Button variant="outline" size="sm" on:click={onRefresh} disabled={loadingTaskRuns}>
          {loadingTaskRuns ? "Loading..." : "Refresh"}
        </Button>
        <Button variant="secondary" size="sm" on:click={onDeriveTaskRuns} disabled={loadingTaskRuns}>
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
          on:change={onTaskRunCanonicalOutcomeFilterChange}
        />
      </div>
      <div class="md:col-span-3 space-y-1">
        <Label>Failure mode</Label>
        <Select
          bind:value={taskRunFailureModeFilter}
          options={taskRunFailureModeOptions}
          on:change={onTaskRunFailureModeFilterChange}
        />
      </div>
      <div class="md:col-span-3 space-y-1">
        <Label>Failure subtype</Label>
        <Select
          bind:value={taskRunFailureSubtypeFilter}
          options={taskRunFailureSubtypeOptions}
          on:change={onNormalizeTaskRunFailureSubtypeFilter}
        />
      </div>
      <div class="md:col-span-3 space-y-1">
        <Label>Human intervention</Label>
        <Select
          bind:value={taskRunHumanInterventionFilter}
          options={taskRunHumanInterventionOptions}
          on:change={onTaskRunHumanInterventionFilterChange}
        />
      </div>
    </div>

    <div class="flex gap-2 flex-wrap">
      <Button
        variant={taskRunCanonicalOutcomeFilter === "none" ? "default" : "outline"}
        size="sm"
        on:click={onToggleNoCanonicalFilter}
      >
        No canonical outcome
      </Button>
      <Button
        variant={taskRunHumanInterventionFilter === "true" ? "default" : "outline"}
        size="sm"
        on:click={onToggleRequiresHumanFilter}
      >
        Requires human intervention
      </Button>
      <Button
        variant={taskRunNeedsLabelingOnly ? "default" : "outline"}
        size="sm"
        on:click={onToggleNeedsLabelingQueue}
      >
        Needs labeling queue
      </Button>
    </div>
  </CardContent>
</Card>
