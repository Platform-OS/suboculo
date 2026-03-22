<script>
  import Card from "./ui/Card.svelte";
  import CardContent from "./ui/CardContent.svelte";
  import Select from "./ui/Select.svelte";
  import { formatPercent, formatMoney, formatSignedPercentDelta } from "$lib/formatters.js";

  export let trendBucket = "day";
  export let trendWindowDays = "30";
  export let trendBucketOptions = [];
  export let trendWindowOptions = [];
  export let reliabilityTrends = null;
  export let reliabilityTrendInsights = null;
  export let reliabilityFailureModeTrends = null;

  function formatBucketStart(value, bucket = "day") {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    if (bucket === "week") return `Week of ${date.toLocaleDateString()}`;
    return date.toLocaleDateString();
  }

  function formatLabel(value) {
    if (!value) return "";
    return String(value).replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function formatFailureModeRow(bucketRow) {
    if (!bucketRow?.by_mode?.length) return "—";
    return bucketRow.by_mode
      .slice(0, 3)
      .map((modeRow) => `${modeRow.failure_mode} ${modeRow.count} (${formatPercent(modeRow.failure_mode_share)})`)
      .join(", ");
  }
</script>

<Card class="rounded-2xl shadow-sm">
  <CardContent class="p-4 md:p-5 space-y-4">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="text-base font-semibold">Reliability Trends</div>
      <div class="flex gap-2">
        <Select bind:value={trendBucket} options={trendBucketOptions} />
        <Select bind:value={trendWindowDays} options={trendWindowOptions} />
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
