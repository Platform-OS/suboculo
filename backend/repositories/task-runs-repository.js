function createTaskRunsRepository(db) {
  const upsertTaskRunStmt = db.prepare(`
    INSERT INTO task_runs (
      task_key, title, description, source, runner, model, agent_system_version, toolchain_version, git_revision, status, root_session_id,
      started_at, ended_at, total_events, total_tool_calls, distinct_tools,
      total_duration_ms, error_count, retry_count, subagent_count, interrupt_count,
      token_input, token_output, token_cache_creation, token_cache_read,
      estimated_cost, estimated_cost_known, metadata, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_key) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      source = excluded.source,
      runner = excluded.runner,
      model = excluded.model,
      agent_system_version = excluded.agent_system_version,
      toolchain_version = excluded.toolchain_version,
      git_revision = excluded.git_revision,
      status = excluded.status,
      root_session_id = excluded.root_session_id,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      total_events = excluded.total_events,
      total_tool_calls = excluded.total_tool_calls,
      distinct_tools = excluded.distinct_tools,
      total_duration_ms = excluded.total_duration_ms,
      error_count = excluded.error_count,
      retry_count = excluded.retry_count,
      subagent_count = excluded.subagent_count,
      interrupt_count = excluded.interrupt_count,
      token_input = excluded.token_input,
      token_output = excluded.token_output,
      token_cache_creation = excluded.token_cache_creation,
      token_cache_read = excluded.token_cache_read,
      estimated_cost = excluded.estimated_cost,
      estimated_cost_known = excluded.estimated_cost_known,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
  `);

  const getTaskRunIdByTaskKeyStmt = db.prepare('SELECT id FROM task_runs WHERE task_key = ?');
  const deleteTaskRunEventLinksStmt = db.prepare('DELETE FROM task_run_events WHERE task_run_id = ?');
  const insertTaskRunEventLinkStmt = db.prepare(`
    INSERT OR IGNORE INTO task_run_events (task_run_id, entry_key)
    VALUES (?, ?)
  `);
  const replaceTaskRunEventLinksTxn = db.transaction((taskRunId, eventRows) => {
    deleteTaskRunEventLinksStmt.run(taskRunId);
    for (const row of eventRows) {
      insertTaskRunEventLinkStmt.run(taskRunId, row.key);
    }
  });

  return {
    listByWhere({ whereSql, params, sortKey, sortDir, limit, offset }) {
      return db.prepare(`
        SELECT *
        FROM task_runs
        WHERE ${whereSql}
        ORDER BY ${sortKey} ${sortDir}
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset);
    },

    countByWhere({ whereSql, params }) {
      return db.prepare(`
        SELECT COUNT(*) AS count
        FROM task_runs
        WHERE ${whereSql}
      `).get(...params)?.count || 0;
    },

    getOutcomeSummaryTotals({ whereSql, params }) {
      return db.prepare(`
        SELECT
          COUNT(*) AS task_runs,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
          ) THEN 1 ELSE 0 END) AS with_canonical_outcome,
          SUM(CASE WHEN NOT EXISTS (
            SELECT 1 FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
          ) THEN 1 ELSE 0 END) AS no_canonical_outcome,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM outcomes o
            WHERE o.task_run_id = tr.id
              AND o.is_canonical = 1
              AND o.requires_human_intervention = 1
          ) THEN 1 ELSE 0 END) AS requires_human_intervention
        FROM task_runs tr
        WHERE ${whereSql}
      `).get(...params);
    },

    listOutcomeSummaryByField({ whereSql, params, field }) {
      return db.prepare(`
        SELECT o.${field} AS value, COUNT(*) AS count
        FROM task_runs tr
        JOIN outcomes o ON o.task_run_id = tr.id AND o.is_canonical = 1
        WHERE ${whereSql}
          ${field === 'failure_mode' || field === 'failure_subtype' ? `AND o.${field} IS NOT NULL` : ''}
        GROUP BY o.${field}
        ORDER BY count DESC, value ASC
      `).all(...params);
    },

    getById(taskRunId) {
      return db.prepare(`
        SELECT *
        FROM task_runs
        WHERE id = ?
      `).get(taskRunId);
    },

    listEventDataForTaskRun(taskRunId) {
      return db.prepare(`
        SELECT e.key, e.data
        FROM task_run_events tre
        JOIN entries e ON e.key = tre.entry_key
        WHERE tre.task_run_id = ?
        ORDER BY e.ts ASC, e.id ASC
      `).all(taskRunId);
    },

    listReportEventRows(taskRunId) {
      return db.prepare(`
        SELECT e.key, e.ts, e.event, e.data
        FROM task_run_events tre
        JOIN entries e ON e.key = tre.entry_key
        WHERE tre.task_run_id = ?
        ORDER BY e.ts ASC, e.id ASC
      `).all(taskRunId);
    },

    getStoredReport(taskRunId) {
      return db.prepare(`
        SELECT report_json, generated_at, report_version, based_on_outcome_id, based_on_task_run_updated_at
        FROM task_run_reports
        WHERE task_run_id = ?
      `).get(taskRunId);
    },

    upsertStoredReport(taskRunId, { reportJson, generatedAt, reportVersion, basedOnOutcomeId, basedOnTaskRunUpdatedAt, updatedAt }) {
      return db.prepare(`
        INSERT INTO task_run_reports (
          task_run_id, report_json, generated_at, report_version, based_on_outcome_id, based_on_task_run_updated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_run_id) DO UPDATE SET
          report_json = excluded.report_json,
          generated_at = excluded.generated_at,
          report_version = excluded.report_version,
          based_on_outcome_id = excluded.based_on_outcome_id,
          based_on_task_run_updated_at = excluded.based_on_task_run_updated_at,
          updated_at = excluded.updated_at
      `).run(
        taskRunId,
        reportJson,
        generatedAt,
        reportVersion,
        basedOnOutcomeId,
        basedOnTaskRunUpdatedAt,
        updatedAt
      );
    },

    clearReportsForTaskRun(taskRunId) {
      return db.prepare('DELETE FROM task_run_reports WHERE task_run_id = ?').run(taskRunId);
    },

    listRowsForRootSession(rootSessionId) {
      return db.prepare(`
        SELECT key, ts, sessionID, rootSessionID, runner, event, data
        FROM entries
        WHERE rootSessionID = ? OR sessionID = ?
        ORDER BY ts ASC, id ASC
      `).all(rootSessionId, rootSessionId);
    },

    upsertTaskRun(taskKey, rootSessionId, summary, updatedAt) {
      return upsertTaskRunStmt.run(
        taskKey,
        summary.title,
        summary.description,
        'derived_attempt',
        summary.runner,
        summary.model,
        summary.agentSystemVersion,
        summary.toolchainVersion,
        summary.gitRevision,
        summary.status,
        rootSessionId,
        summary.startedAt,
        summary.endedAt,
        summary.totalEvents,
        summary.totalToolCalls,
        summary.distinctTools,
        summary.totalDurationMs,
        summary.errorCount,
        summary.retryCount,
        summary.subagentCount,
        summary.interruptCount,
        summary.tokenInput,
        summary.tokenOutput,
        summary.tokenCacheCreation,
        summary.tokenCacheRead,
        summary.estimatedCost,
        summary.estimatedCostKnown,
        summary.metadata,
        updatedAt
      );
    },

    getTaskRunIdByTaskKey(taskKey) {
      return getTaskRunIdByTaskKeyStmt.get(taskKey)?.id || null;
    },

    replaceTaskRunEventLinks(taskRunId, eventRows) {
      replaceTaskRunEventLinksTxn(taskRunId, eventRows);
    },

    listDistinctRootSessionIds() {
      return db.prepare(`
        SELECT DISTINCT COALESCE(rootSessionID, sessionID) AS rootSessionId
        FROM entries
        WHERE COALESCE(rootSessionID, sessionID) IS NOT NULL
        ORDER BY rootSessionId
      `).all();
    }
  };
}

module.exports = {
  createTaskRunsRepository
};
