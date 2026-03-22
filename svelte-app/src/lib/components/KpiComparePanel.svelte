<script>
  import { onDestroy, onMount } from "svelte";
  import * as api from "$lib/api.js";
  import Card from "./ui/Card.svelte";
  import CardContent from "./ui/CardContent.svelte";
  import Button from "./ui/Button.svelte";
  import Input from "./ui/Input.svelte";
  import Select from "./ui/Select.svelte";
  import Badge from "./ui/Badge.svelte";
  import {
    formatPercent,
    formatMoney,
    formatSignedPercentDelta,
    formatSignedNumberDelta,
    formatPeriodRange
  } from "$lib/formatters.js";

  export let filters = {};
  export let refreshKey = 0;
  export let compareMode = "preset";
  export let comparePreset = "7";
  export let periodAFrom = "";
  export let periodATo = "";
  export let periodBFrom = "";
  export let periodBTo = "";
  export let showNotice = () => {};

  let loading = false;
  let compare = null;
  let loadTimer;

  const comparePresetOptions = [
    { value: "7", label: "Last 7 vs previous 7" },
    { value: "14", label: "Last 14 vs previous 14" },
    { value: "30", label: "Last 30 vs previous 30" }
  ];
  const compareModeOptions = [
    { value: "preset", label: "Preset window" },
    { value: "custom", label: "Custom A/B ranges" }
  ];

  onMount(async () => {
    await loadCompare();
  });

  onDestroy(() => {
    clearTimeout(loadTimer);
  });

  function toIsoStartOfDay(dateInput) {
    if (!dateInput) return null;
    const value = new Date(`${dateInput}T00:00:00`);
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }

  function toIsoEndOfDay(dateInput) {
    if (!dateInput) return null;
    const value = new Date(`${dateInput}T23:59:59.999`);
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }

  function buildCompareFilters(baseFilters) {
    if (compareMode === "custom") {
      const aFrom = toIsoStartOfDay(periodAFrom);
      const aTo = toIsoEndOfDay(periodATo);
      const bFrom = toIsoStartOfDay(periodBFrom);
      const bTo = toIsoEndOfDay(periodBTo);

      if (aFrom && aTo && bFrom && bTo) {
        return {
          ...baseFilters,
          period_a_from: aFrom,
          period_a_to: aTo,
          period_b_from: bFrom,
          period_b_to: bTo
        };
      }
    }
    return {
      ...baseFilters,
      period_days: comparePreset
    };
  }

  function scheduleLoadCompare() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      loadCompare();
    }, 120);
  }

  async function loadCompare() {
    try {
      loading = true;
      compare = await api.getReliabilityKpiCompare(buildCompareFilters(filters || {}));
    } catch (err) {
      console.error("Failed to load KPI compare:", err);
      compare = null;
    } finally {
      loading = false;
    }
  }

  async function copyKpiCompareShareLink() {
    const link = window.location.href;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = link;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      showNotice("KPI compare link copied", "success");
    } catch (err) {
      console.error("Failed to copy KPI compare link:", err);
      showNotice("Failed to copy KPI compare link", "error");
    }
  }

  function getDeltaTrend(metricKey, delta) {
    if (delta == null || Number.isNaN(delta)) return { label: "Insufficient data", tone: "muted" };
    const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    if (direction === "flat") return { label: "No change", tone: "muted" };
    const higherIsBetter = metricKey === "success_rate" || metricKey === "first_pass_rate";
    const lowerIsBetter = metricKey === "retry_rate" || metricKey === "intervention_rate" || metricKey === "cost_per_success";
    if (higherIsBetter) return direction === "up" ? { label: "Improving", tone: "good" } : { label: "Degrading", tone: "bad" };
    if (lowerIsBetter) return direction === "down" ? { label: "Improving", tone: "good" } : { label: "Degrading", tone: "bad" };
    return direction === "up" ? { label: "Higher", tone: "neutral" } : { label: "Lower", tone: "neutral" };
  }

  function compareToneClass(tone) {
    if (tone === "good") return "text-green-700";
    if (tone === "bad") return "text-red-700";
    return "text-muted-foreground";
  }

  function getPeriodGuardrails(period, thresholds) {
    const guards = [];
    const canonicalCount = period?.counts?.with_canonical_outcome ?? 0;
    const knownCostSuccessCount = period?.counts?.successful_runs_with_known_cost ?? 0;
    const minCanonical = thresholds?.min_canonical_sample ?? 0;
    const minCost = thresholds?.min_success_sample_for_cost ?? 0;
    if (canonicalCount < minCanonical) guards.push({ key: "canonical", severity: "warn", message: `Canonical outcomes ${canonicalCount}/${minCanonical}` });
    if (knownCostSuccessCount < minCost) guards.push({ key: "cost", severity: "warn", message: `Known-cost successes ${knownCostSuccessCount}/${minCost}` });
    if (!guards.length) guards.push({ key: "ok", severity: "ok", message: "Guardrails satisfied" });
    return guards;
  }

  function isMetricGuardrailSatisfied(metricKey, period, thresholds) {
    const canonicalCount = period?.counts?.with_canonical_outcome ?? 0;
    const knownCostSuccessCount = period?.counts?.successful_runs_with_known_cost ?? 0;
    const minCanonical = thresholds?.min_canonical_sample ?? 0;
    const minCost = thresholds?.min_success_sample_for_cost ?? 0;
    if (metricKey === "cost_per_success") return knownCostSuccessCount >= minCost;
    if (["success_rate", "first_pass_rate", "retry_rate", "intervention_rate"].includes(metricKey)) return canonicalCount >= minCanonical;
    return true;
  }

  function getMetricSampleNote(metricKey, comparePayload) {
    if (!comparePayload) return "";
    const periodAOk = isMetricGuardrailSatisfied(metricKey, comparePayload.period_a, comparePayload.thresholds);
    const periodBOk = isMetricGuardrailSatisfied(metricKey, comparePayload.period_b, comparePayload.thresholds);
    if (periodAOk && periodBOk) return "";
    return "Insufficient sample";
  }

  $: if (refreshKey) {
    scheduleLoadCompare();
  }
</script>

<Card class="rounded-2xl shadow-sm">
  <CardContent class="p-4 md:p-5 space-y-4">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="text-base font-semibold">KPI Compare</div>
      <div class="flex items-center gap-2">
        <Select bind:value={compareMode} options={compareModeOptions} />
        {#if compareMode === "preset"}
          <Select bind:value={comparePreset} options={comparePresetOptions} />
        {/if}
        <Button variant="outline" size="sm" on:click={copyKpiCompareShareLink}>
          Copy share link
        </Button>
      </div>
    </div>

    {#if compareMode === "custom"}
      <div class="rounded-xl border p-3 bg-muted/10 space-y-3">
        <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Custom A/B ranges</div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div class="space-y-2">
            <div class="text-xs text-muted-foreground">Period A (current)</div>
            <div class="grid grid-cols-2 gap-2">
              <Input bind:value={periodAFrom} type="date" />
              <Input bind:value={periodATo} type="date" />
            </div>
          </div>
          <div class="space-y-2">
            <div class="text-xs text-muted-foreground">Period B (baseline)</div>
            <div class="grid grid-cols-2 gap-2">
              <Input bind:value={periodBFrom} type="date" />
              <Input bind:value={periodBTo} type="date" />
            </div>
          </div>
        </div>
        {#if !(periodAFrom && periodATo && periodBFrom && periodBTo)}
          <div class="text-xs text-muted-foreground">
            Fill all four dates to activate custom compare; otherwise preset window is used.
          </div>
        {/if}
      </div>
    {/if}

    {#if loading}
      <div class="text-sm text-muted-foreground">Loading KPI compare...</div>
    {:else if compare}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div class="rounded-xl border p-3 bg-muted/10">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Period A (current)</div>
          <div class="text-sm">{formatPeriodRange(compare.period_a)}</div>
          <div class="text-xs text-muted-foreground mt-1">{compare.period_a?.counts?.task_runs ?? 0} runs</div>
          <div class="mt-2 flex flex-wrap gap-1">
            {#each getPeriodGuardrails(compare.period_a, compare.thresholds) as guard (`a-${guard.key}`)}
              <Badge variant={guard.severity === "ok" ? "outline" : "secondary"}>{guard.message}</Badge>
            {/each}
          </div>
        </div>
        <div class="rounded-xl border p-3 bg-muted/10">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Period B (baseline)</div>
          <div class="text-sm">{formatPeriodRange(compare.period_b)}</div>
          <div class="text-xs text-muted-foreground mt-1">{compare.period_b?.counts?.task_runs ?? 0} runs</div>
          <div class="mt-2 flex flex-wrap gap-1">
            {#each getPeriodGuardrails(compare.period_b, compare.thresholds) as guard (`b-${guard.key}`)}
              <Badge variant={guard.severity === "ok" ? "outline" : "secondary"}>{guard.message}</Badge>
            {/each}
          </div>
        </div>
      </div>

      <div class="overflow-auto rounded-xl border">
        <table class="min-w-full text-sm">
          <thead class="bg-muted/20 text-xs text-muted-foreground uppercase tracking-wide">
            <tr>
              <th class="px-3 py-2 text-left">Metric</th>
              <th class="px-3 py-2 text-right">Period A</th>
              <th class="px-3 py-2 text-right">Period B</th>
              <th class="px-3 py-2 text-right">Delta</th>
              <th class="px-3 py-2 text-right">Direction</th>
            </tr>
          </thead>
          <tbody>
            <tr class="border-t">
              <td class="px-3 py-2">Success rate</td>
              <td class="px-3 py-2 text-right">{formatPercent(compare.period_a?.rates?.success_rate)}</td>
              <td class="px-3 py-2 text-right">{formatPercent(compare.period_b?.rates?.success_rate)}</td>
              <td class="px-3 py-2 text-right">{formatSignedPercentDelta(compare.deltas?.rates?.success_rate)}</td>
              <td class={`px-3 py-2 text-right ${compareToneClass(getDeltaTrend("success_rate", compare.deltas?.rates?.success_rate).tone)}`}>
                {#if getMetricSampleNote("success_rate", compare)}
                  <span class="text-muted-foreground">{getMetricSampleNote("success_rate", compare)}</span>
                {:else}
                  {getDeltaTrend("success_rate", compare.deltas?.rates?.success_rate).label}
                {/if}
              </td>
            </tr>
            <tr class="border-t">
              <td class="px-3 py-2">First-pass rate</td>
              <td class="px-3 py-2 text-right">{formatPercent(compare.period_a?.rates?.first_pass_rate)}</td>
              <td class="px-3 py-2 text-right">{formatPercent(compare.period_b?.rates?.first_pass_rate)}</td>
              <td class="px-3 py-2 text-right">{formatSignedPercentDelta(compare.deltas?.rates?.first_pass_rate)}</td>
              <td class={`px-3 py-2 text-right ${compareToneClass(getDeltaTrend("first_pass_rate", compare.deltas?.rates?.first_pass_rate).tone)}`}>
                {#if getMetricSampleNote("first_pass_rate", compare)}
                  <span class="text-muted-foreground">{getMetricSampleNote("first_pass_rate", compare)}</span>
                {:else}
                  {getDeltaTrend("first_pass_rate", compare.deltas?.rates?.first_pass_rate).label}
                {/if}
              </td>
            </tr>
            <tr class="border-t">
              <td class="px-3 py-2">Retry rate</td>
              <td class="px-3 py-2 text-right">{formatPercent(compare.period_a?.rates?.retry_rate)}</td>
              <td class="px-3 py-2 text-right">{formatPercent(compare.period_b?.rates?.retry_rate)}</td>
              <td class="px-3 py-2 text-right">{formatSignedPercentDelta(compare.deltas?.rates?.retry_rate)}</td>
              <td class={`px-3 py-2 text-right ${compareToneClass(getDeltaTrend("retry_rate", compare.deltas?.rates?.retry_rate).tone)}`}>
                {#if getMetricSampleNote("retry_rate", compare)}
                  <span class="text-muted-foreground">{getMetricSampleNote("retry_rate", compare)}</span>
                {:else}
                  {getDeltaTrend("retry_rate", compare.deltas?.rates?.retry_rate).label}
                {/if}
              </td>
            </tr>
            <tr class="border-t">
              <td class="px-3 py-2">Intervention rate</td>
              <td class="px-3 py-2 text-right">{formatPercent(compare.period_a?.rates?.intervention_rate)}</td>
              <td class="px-3 py-2 text-right">{formatPercent(compare.period_b?.rates?.intervention_rate)}</td>
              <td class="px-3 py-2 text-right">{formatSignedPercentDelta(compare.deltas?.rates?.intervention_rate)}</td>
              <td class={`px-3 py-2 text-right ${compareToneClass(getDeltaTrend("intervention_rate", compare.deltas?.rates?.intervention_rate).tone)}`}>
                {#if getMetricSampleNote("intervention_rate", compare)}
                  <span class="text-muted-foreground">{getMetricSampleNote("intervention_rate", compare)}</span>
                {:else}
                  {getDeltaTrend("intervention_rate", compare.deltas?.rates?.intervention_rate).label}
                {/if}
              </td>
            </tr>
            <tr class="border-t">
              <td class="px-3 py-2">Cost per success</td>
              <td class="px-3 py-2 text-right">{formatMoney(compare.period_a?.cost?.cost_per_success)}</td>
              <td class="px-3 py-2 text-right">{formatMoney(compare.period_b?.cost?.cost_per_success)}</td>
              <td class="px-3 py-2 text-right">{formatSignedNumberDelta(compare.deltas?.cost?.cost_per_success, 4)}</td>
              <td class={`px-3 py-2 text-right ${compareToneClass(getDeltaTrend("cost_per_success", compare.deltas?.cost?.cost_per_success).tone)}`}>
                {#if getMetricSampleNote("cost_per_success", compare)}
                  <span class="text-muted-foreground">{getMetricSampleNote("cost_per_success", compare)}</span>
                {:else}
                  {getDeltaTrend("cost_per_success", compare.deltas?.cost?.cost_per_success).label}
                {/if}
              </td>
            </tr>
            <tr class="border-t">
              <td class="px-3 py-2">Task runs</td>
              <td class="px-3 py-2 text-right">{compare.period_a?.counts?.task_runs ?? 0}</td>
              <td class="px-3 py-2 text-right">{compare.period_b?.counts?.task_runs ?? 0}</td>
              <td class="px-3 py-2 text-right">{formatSignedNumberDelta(compare.deltas?.counts?.task_runs, 0)}</td>
              <td class={`px-3 py-2 text-right ${compareToneClass(getDeltaTrend("task_runs", compare.deltas?.counts?.task_runs).tone)}`}>
                {getDeltaTrend("task_runs", compare.deltas?.counts?.task_runs).label}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div class="rounded-xl border p-3 space-y-2">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Current period flags</div>
          {#if compare.period_a?.anomalies?.length}
            <div class="flex flex-wrap gap-1">
              {#each compare.period_a.anomalies as anomaly (`cmp-a-${anomaly.code}`)}
                <Badge variant={anomaly.severity === "high" ? "destructive" : "outline"} title={anomaly.message}>
                  {anomaly.code}
                </Badge>
              {/each}
            </div>
          {:else}
            <div class="text-xs text-muted-foreground">No flags.</div>
          {/if}
        </div>
        <div class="rounded-xl border p-3 space-y-2">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Previous period flags</div>
          {#if compare.period_b?.anomalies?.length}
            <div class="flex flex-wrap gap-1">
              {#each compare.period_b.anomalies as anomaly (`cmp-b-${anomaly.code}`)}
                <Badge variant={anomaly.severity === "high" ? "destructive" : "outline"} title={anomaly.message}>
                  {anomaly.code}
                </Badge>
              {/each}
            </div>
          {:else}
            <div class="text-xs text-muted-foreground">No flags.</div>
          {/if}
        </div>
      </div>
    {:else}
      <div class="text-sm text-muted-foreground">No KPI comparison data in current scope.</div>
    {/if}
  </CardContent>
</Card>
