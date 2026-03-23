export async function fetchTaskRunsBundle({
  api,
  filters,
  trendBucket,
  trendWindowDays
}) {
  const trendFilters = {
    ...filters,
    bucket: trendBucket,
    window_days: trendWindowDays
  };

  const [result, summary, kpis, kpisByRunner, trends, trendInsights, failureModeTrends] = await Promise.all([
    api.getTaskRuns(filters),
    api.getTaskRunOutcomeSummary(filters),
    api.getReliabilityKpis(filters),
    api.getReliabilityKpisByRunner(filters),
    api.getReliabilityTrends(trendFilters),
    api.getReliabilityTrendInsights(trendFilters),
    api.getReliabilityFailureModeTrends(trendFilters)
  ]);

  return {
    result,
    summary,
    kpis,
    kpisByRunner,
    trends,
    trendInsights,
    failureModeTrends
  };
}

export function filterSelectedTaskRunIds(taskRuns, selectedTaskRunIds) {
  return new Set(
    [...selectedTaskRunIds].filter((id) => taskRuns.some((run) => run.id === id))
  );
}
