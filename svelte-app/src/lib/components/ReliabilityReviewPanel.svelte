<script>
  import { onDestroy } from "svelte";
  import * as api from "$lib/api.js";
  import Card from "./ui/Card.svelte";
  import CardContent from "./ui/CardContent.svelte";
  import Button from "./ui/Button.svelte";
  import Input from "./ui/Input.svelte";
  import Badge from "./ui/Badge.svelte";
  import {
    formatTs,
    formatPercent,
    formatMoney,
    formatSignedPercentDelta,
    formatSignedNumberDelta,
    formatPeriodRange
  } from "$lib/formatters.js";

  export let filters = {};
  export let refreshKey = 0;
  export let trendBucket = "day";
  export let showNotice = () => {};
  export let onOpenTaskRun = () => {};
  export let onOpenNeedsLabelingQueue = () => {};

  let review = null;
  let loading = false;
  let loadTimer;

  let weeklyReviewHistory = [];
  let showWeeklyReviewHistory = false;
  let loadingWeeklyReviewHistory = false;
  let acknowledgingReview = false;
  let reviewAcknowledgeReviewer = "web-ui";
  let reviewAcknowledgeNotes = "";

  onDestroy(() => {
    clearTimeout(loadTimer);
  });

  function scheduleLoadReview() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      loadReview();
    }, 120);
  }

  async function loadReview() {
    try {
      loading = true;
      review = await api.getReliabilityReview({
        ...(filters || {}),
        bucket: trendBucket
      });
      if (showWeeklyReviewHistory) {
        await loadWeeklyReviewHistory();
      }
    } catch (err) {
      console.error("Failed to load reliability review:", err);
      review = null;
      weeklyReviewHistory = [];
    } finally {
      loading = false;
    }
  }

  function formatLabel(value) {
    if (!value) return "";
    return String(value).replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function getWeekStartIso(weeksAgo = 0) {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const day = d.getUTCDay();
    const delta = day === 0 ? 6 : day - 1;
    d.setUTCDate(d.getUTCDate() - delta - (weeksAgo * 7));
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }

  async function loadWeeklyReviewHistory() {
    try {
      loadingWeeklyReviewHistory = true;
      const requests = [0, 1, 2, 3].map((weeksAgo) => (
        api.getReliabilityReview({
          ...(filters || {}),
          bucket: "week",
          week_of: getWeekStartIso(weeksAgo)
        })
      ));
      weeklyReviewHistory = await Promise.all(requests);
    } catch (err) {
      console.error("Failed to load weekly review history:", err);
      weeklyReviewHistory = [];
    } finally {
      loadingWeeklyReviewHistory = false;
    }
  }

  async function toggleWeeklyReviewHistory() {
    showWeeklyReviewHistory = !showWeeklyReviewHistory;
    if (showWeeklyReviewHistory && weeklyReviewHistory.length === 0) {
      await loadWeeklyReviewHistory();
    }
  }

  async function copyReliabilityReviewMarkdown() {
    if (!review?.markdown) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(review.markdown);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = review.markdown;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      showNotice("Reliability review copied to clipboard", "success");
    } catch (err) {
      console.error("Failed to copy reliability review:", err);
      showNotice("Failed to copy reliability review", "error");
    }
  }

  async function downloadReliabilityReviewMarkdown() {
    if (!review?.markdown) return;
    try {
      const from = review?.period?.from ? new Date(review.period.from).toISOString().slice(0, 10) : "unknown";
      const to = review?.period?.to ? new Date(review.period.to).toISOString().slice(0, 10) : "unknown";
      const runner = review?.filters?.runner || "all-runners";
      const filename = `reliability-review-${runner}-${from}-to-${to}.md`;
      const blob = new Blob([review.markdown], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      showNotice("Reliability review downloaded", "success");
    } catch (err) {
      console.error("Failed to download reliability review:", err);
      showNotice("Failed to download reliability review", "error");
    }
  }

  async function acknowledgeCurrentReview() {
    if (!review?.period?.from || !review?.period?.to) {
      showNotice("Cannot acknowledge review without explicit period", "error");
      return;
    }
    try {
      acknowledgingReview = true;
      await api.acknowledgeReliabilityReview({
        period_from: review.period.from,
        period_to: review.period.to,
        runner: review?.filters?.runner || undefined,
        reviewer: reviewAcknowledgeReviewer || "web-ui",
        notes: reviewAcknowledgeNotes || undefined
      });
      reviewAcknowledgeNotes = "";
      await loadReview();
      if (showWeeklyReviewHistory) await loadWeeklyReviewHistory();
      showNotice("Review acknowledged", "success");
    } catch (err) {
      console.error("Failed to acknowledge review:", err);
      showNotice("Failed to acknowledge review", "error");
    } finally {
      acknowledgingReview = false;
    }
  }

  $: if (refreshKey) {
    scheduleLoadReview();
  }
</script>

<Card class="rounded-2xl shadow-sm">
  <CardContent class="p-4 md:p-5 space-y-4">
    <div class="flex items-center justify-between gap-2">
      <div class="text-base font-semibold">Reliability Review</div>
      <div class="flex items-center gap-2">
        {#if loading}
          <Badge variant="outline">Updating…</Badge>
        {/if}
        <Button variant="outline" size="sm" on:click={toggleWeeklyReviewHistory}>
          {showWeeklyReviewHistory ? "Hide last 4 weeks" : "Show last 4 weeks"}
        </Button>
        <Button variant="outline" size="sm" on:click={copyReliabilityReviewMarkdown} disabled={!review?.markdown}>
          Copy markdown
        </Button>
        <Button variant="outline" size="sm" on:click={downloadReliabilityReviewMarkdown} disabled={!review?.markdown}>
          Download
        </Button>
      </div>
    </div>

    <div class="min-h-[300px]">
    {#if review}
      <div class="rounded-xl border p-3 bg-muted/10 flex items-center justify-between gap-3 flex-wrap">
        <div class="text-sm">
          <span class="text-muted-foreground">Period:</span>
          <span class="font-medium ml-1">{formatPeriodRange(review.period)}</span>
        </div>
        <div class="flex items-center gap-2">
          {#if review.acknowledgement?.acknowledged}
            <Badge variant="outline">
              Reviewed by {review.acknowledgement.reviewer} on {formatTs(review.acknowledgement.acknowledged_at)}
            </Badge>
          {:else}
            <Badge variant="secondary">Not reviewed</Badge>
          {/if}
        </div>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div class="rounded-xl border p-3 bg-muted/10">
          <div class="text-xs text-muted-foreground">Task runs</div>
          <div class="text-xl font-semibold">{review.kpis?.counts?.task_runs ?? 0}</div>
        </div>
        <div class="rounded-xl border p-3 bg-muted/10">
          <div class="text-xs text-muted-foreground">Success rate</div>
          <div class="text-xl font-semibold">{formatPercent(review.kpis?.rates?.success_rate)}</div>
        </div>
        <div class="rounded-xl border p-3 bg-muted/10">
          <div class="text-xs text-muted-foreground">Retry rate</div>
          <div class="text-xl font-semibold">{formatPercent(review.kpis?.rates?.retry_rate)}</div>
        </div>
        <div class="rounded-xl border p-3 bg-muted/10">
          <div class="text-xs text-muted-foreground">Cost per success</div>
          <div class="text-xl font-semibold">{formatMoney(review.kpis?.cost?.cost_per_success)}</div>
        </div>
      </div>

      <div class="rounded-xl border p-3 space-y-2">
        <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Anomalies</div>
        {#if review.anomalies?.length}
          <div class="flex flex-wrap gap-1">
            {#each review.anomalies as anomaly (`review-${anomaly.code}`)}
              <Badge variant={anomaly.severity === "high" ? "destructive" : "outline"} title={anomaly.message}>
                {formatLabel(anomaly.code)}
              </Badge>
            {/each}
          </div>
        {:else}
          <div class="text-sm text-muted-foreground">No anomaly flags in current scope.</div>
        {/if}
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          type="button"
          class="rounded-xl border p-3 text-left hover:bg-muted/20 transition-colors"
          on:click={onOpenNeedsLabelingQueue}
        >
          <div class="text-xs text-muted-foreground">Needs labeling</div>
          <div class="text-2xl font-semibold">{review.labeling_backlog?.no_canonical_outcome_runs ?? 0}</div>
          <div class="text-xs text-muted-foreground mt-1">Click to open labeling queue</div>
        </button>

        <div class="rounded-xl border p-3 space-y-2">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Top failing runs</div>
          {#if review.top_failing_runs?.length}
            <div class="space-y-1">
              {#each review.top_failing_runs as run (`review-run-${run.id}`)}
                <button
                  type="button"
                  class="w-full text-left text-sm rounded px-2 py-1 hover:bg-muted/20"
                  on:click={() => onOpenTaskRun(run.id)}
                >
                  <div class="font-mono truncate">{run.task_key}</div>
                  <div class="text-xs text-muted-foreground">
                    {run.canonical_outcome_label || "unknown"} · errors {run.error_count} · {formatMoney(run.estimated_cost)}
                  </div>
                </button>
              {/each}
            </div>
          {:else}
            <div class="text-sm text-muted-foreground">No failing runs in current scope.</div>
          {/if}
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div class="rounded-xl border p-3 space-y-2">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Trend delta (latest)</div>
          {#if review.trends?.delta_from_previous_bucket}
            <div class="text-sm flex items-center justify-between">
              <span>Success rate</span>
              <span>{formatSignedPercentDelta(review.trends.delta_from_previous_bucket.success_rate_delta)}</span>
            </div>
            <div class="text-sm flex items-center justify-between">
              <span>Retry rate</span>
              <span>{formatSignedPercentDelta(review.trends.delta_from_previous_bucket.retry_rate_delta)}</span>
            </div>
            <div class="text-sm flex items-center justify-between">
              <span>Cost per success</span>
              <span>{formatSignedNumberDelta(review.trends.delta_from_previous_bucket.cost_per_success_delta, 4)}</span>
            </div>
          {:else}
            <div class="text-sm text-muted-foreground">No previous bucket to compare.</div>
          {/if}
        </div>
        <div class="rounded-xl border p-3 space-y-2">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Failure modes (latest)</div>
          {#if review.failure_modes?.latest_bucket?.by_mode?.length}
            {#each review.failure_modes.latest_bucket.by_mode.slice(0, 4) as mode (`review-mode-${mode.failure_mode}`)}
              <div class="text-sm flex items-center justify-between">
                <span>{mode.failure_mode}</span>
                <span class="text-muted-foreground">{mode.count} ({formatPercent(mode.failure_mode_share)})</span>
              </div>
            {/each}
          {:else}
            <div class="text-sm text-muted-foreground">No failure modes in this period.</div>
          {/if}
        </div>
      </div>

      <div class="rounded-xl border p-3 space-y-3">
        <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Review Acknowledgement</div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input bind:value={reviewAcknowledgeReviewer} placeholder="Reviewer (e.g. web-ui)" />
          <Input bind:value={reviewAcknowledgeNotes} placeholder="Optional notes" class="md:col-span-2" />
        </div>
        <div class="flex items-center gap-2">
          <Button size="sm" on:click={acknowledgeCurrentReview} disabled={acknowledgingReview || !reviewAcknowledgeReviewer}>
            {acknowledgingReview ? "Marking..." : "Mark reviewed"}
          </Button>
          {#if review.acknowledgement?.notes}
            <span class="text-xs text-muted-foreground">Last note: {review.acknowledgement.notes}</span>
          {/if}
        </div>
      </div>

      {#if showWeeklyReviewHistory}
        <div class="rounded-xl border p-3 space-y-2">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Last 4 weeks</div>
          {#if loadingWeeklyReviewHistory}
            <div class="text-sm text-muted-foreground">Loading weekly snapshots...</div>
          {:else if weeklyReviewHistory.length}
            <div class="space-y-1">
              {#each weeklyReviewHistory as item (`weekly-${item.period?.from || item.generated_at}`)}
                <div class="text-sm flex items-center justify-between">
                  <span>{formatPeriodRange(item.period)}</span>
                  <span class="text-muted-foreground">
                    {item.kpis?.counts?.task_runs ?? 0} runs · {formatPercent(item.kpis?.rates?.success_rate)} success
                  </span>
                </div>
              {/each}
            </div>
          {:else}
            <div class="text-sm text-muted-foreground">No weekly history available.</div>
          {/if}
        </div>
      {/if}
    {:else if loading}
      <div class="text-sm text-muted-foreground min-h-[120px]">Loading reliability review...</div>
    {:else}
      <div class="text-sm text-muted-foreground">No review data in current scope.</div>
    {/if}
    </div>
  </CardContent>
</Card>
