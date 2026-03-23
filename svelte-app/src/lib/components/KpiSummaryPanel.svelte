<script>
  import Card from "./ui/Card.svelte";
  import CardContent from "./ui/CardContent.svelte";
  import Button from "./ui/Button.svelte";
  import Badge from "./ui/Badge.svelte";
  import { formatPercent, formatMoney } from "$lib/formatters.js";

  export let loading = false;
  export let kpiDefinitions = null;
  export let reliabilityKpisByRunner = null;
  export let reliabilityKpis = null;
  export let taskRunOutcomeSummary = null;

  let showKpiDefinitions = false;

  function formatLabel(value) {
    if (!value) return "";
    return String(value).replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  }
</script>

<Card class="rounded-2xl shadow-sm">
  <CardContent class="p-4 md:p-5 space-y-4">
    <div class="flex items-center justify-between gap-2">
      <div class="text-base font-semibold">Runner Comparison</div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" on:click={() => showKpiDefinitions = !showKpiDefinitions}>
          {showKpiDefinitions ? "Hide metric definitions" : "Show metric definitions"}
        </Button>
        {#if loading}
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

    <div class="min-h-[220px]">
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
    </div>
  </CardContent>
</Card>

<Card class="rounded-2xl shadow-sm">
  <CardContent class="p-4 md:p-5 space-y-4">
    <div class="flex items-center justify-between gap-2">
      <div class="text-base font-semibold">Reliability KPIs</div>
      {#if loading}
        <Badge variant="outline">Updating…</Badge>
      {/if}
    </div>
    <div class="min-h-[200px] space-y-3">
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
    </div>
  </CardContent>
</Card>

<Card class="rounded-2xl shadow-sm">
  <CardContent class="p-4 md:p-5 space-y-4">
    <div class="flex items-center justify-between gap-2">
      <div class="text-base font-semibold">Outcome Summary</div>
      {#if loading}
        <Badge variant="outline">Updating…</Badge>
      {/if}
    </div>
    <div class="min-h-[260px] space-y-3">
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
    </div>
  </CardContent>
</Card>
