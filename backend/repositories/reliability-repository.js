function createReliabilityRepository(db) {
  return {
    fetchTrendRows({ whereSql, params }) {
      return db.prepare(`
        SELECT
          tr.id,
          tr.runner,
          tr.started_at,
          tr.retry_count,
          tr.estimated_cost,
          tr.estimated_cost_known,
          (
            SELECT o.outcome_label
            FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
            ORDER BY o.evaluated_at DESC, o.id DESC
            LIMIT 1
          ) AS canonical_outcome_label
        FROM task_runs tr
        WHERE ${whereSql}
          AND tr.started_at IS NOT NULL
        ORDER BY tr.started_at ASC
      `).all(...params);
    },

    fetchFailureModeTrendRows({ whereSql, params }) {
      return db.prepare(`
        SELECT
          tr.runner,
          tr.started_at,
          (
            SELECT o.outcome_label
            FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
            ORDER BY o.evaluated_at DESC, o.id DESC
            LIMIT 1
          ) AS canonical_outcome_label,
          (
            SELECT o.failure_mode
            FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
            ORDER BY o.evaluated_at DESC, o.id DESC
            LIMIT 1
          ) AS canonical_failure_mode
        FROM task_runs tr
        WHERE ${whereSql}
          AND tr.started_at IS NOT NULL
        ORDER BY tr.started_at ASC
      `).all(...params);
    },

    fetchReliabilityRows({ whereSql, params }) {
      return db.prepare(`
        SELECT
          tr.id,
          tr.runner,
          tr.retry_count,
          tr.estimated_cost,
          tr.estimated_cost_known,
          tr.total_duration_ms,
          tr.token_input,
          tr.token_output,
          tr.token_cache_creation,
          tr.token_cache_read,
          (
            SELECT o.outcome_label
            FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
            ORDER BY o.evaluated_at DESC, o.id DESC
            LIMIT 1
          ) AS canonical_outcome_label,
          (
            SELECT o.requires_human_intervention
            FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
            ORDER BY o.evaluated_at DESC, o.id DESC
            LIMIT 1
          ) AS canonical_requires_human_intervention
        FROM task_runs tr
        WHERE ${whereSql}
      `).all(...params);
    },

    countLabelingBacklog({ whereSql, params }) {
      return db.prepare(`
        SELECT COUNT(*) AS count
        FROM task_runs tr
        WHERE ${whereSql}
      `).get(...params)?.count || 0;
    },

    listTopFailingRuns({ whereSql, params, limit = 5 }) {
      return db.prepare(`
        SELECT
          tr.id,
          tr.task_key,
          tr.title,
          tr.runner,
          tr.started_at,
          tr.ended_at,
          tr.error_count,
          tr.retry_count,
          tr.estimated_cost,
          (
            SELECT o.outcome_label
            FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
            ORDER BY o.evaluated_at DESC, o.id DESC
            LIMIT 1
          ) AS canonical_outcome_label,
          (
            SELECT o.failure_mode
            FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
            ORDER BY o.evaluated_at DESC, o.id DESC
            LIMIT 1
          ) AS canonical_failure_mode
        FROM task_runs tr
        WHERE ${whereSql}
          AND EXISTS (
            SELECT 1
            FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
              AND o.outcome_label IN ('failure', 'unsafe_success', 'interrupted', 'abandoned')
          )
        ORDER BY tr.error_count DESC, tr.estimated_cost DESC, tr.started_at DESC
        LIMIT ?
      `).all(...params, limit);
    }
  };
}

module.exports = {
  createReliabilityRepository
};
