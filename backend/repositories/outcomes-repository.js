function createOutcomesRepository(db) {
  return {
    clearCanonicalForTaskRun(taskRunId) {
      return db.prepare('UPDATE outcomes SET is_canonical = 0 WHERE task_run_id = ?').run(taskRunId);
    },

    insertOutcome(taskRunId, input, evaluatedAt) {
      return db.prepare(`
        INSERT INTO outcomes (
          task_run_id, evaluation_type, outcome_label, correctness_score, safety_score,
          efficiency_score, reproducibility_score, requires_human_intervention,
          failure_mode, failure_subtype, notes, evaluator, evidence, is_canonical, evaluated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskRunId,
        input.evaluation_type,
        input.outcome_label,
        input.correctness_score,
        input.safety_score,
        input.efficiency_score,
        input.reproducibility_score,
        input.requires_human_intervention ? 1 : 0,
        input.failure_mode,
        input.failure_subtype,
        input.notes,
        input.evaluator,
        input.evidence == null ? null : JSON.stringify(input.evidence),
        input.is_canonical ? 1 : 0,
        evaluatedAt
      );
    },

    getCanonicalOutcomeForTaskRun(taskRunId) {
      return db.prepare(`
        SELECT *
        FROM outcomes
        WHERE task_run_id = ?
          AND is_canonical = 1
        ORDER BY evaluated_at DESC, id DESC
        LIMIT 1
      `).get(taskRunId) || null;
    },

    getCanonicalOutcomeHeaderForTaskRun(taskRunId) {
      return db.prepare(`
        SELECT id, evaluation_type, outcome_label, evaluator, evaluated_at
        FROM outcomes
        WHERE task_run_id = ?
          AND is_canonical = 1
        ORDER BY evaluated_at DESC, id DESC
        LIMIT 1
      `).get(taskRunId) || null;
    },

    getCanonicalOutcomeIdForTaskRun(taskRunId) {
      return db.prepare(`
        SELECT id
        FROM outcomes
        WHERE task_run_id = ?
          AND is_canonical = 1
        ORDER BY evaluated_at DESC, id DESC
        LIMIT 1
      `).get(taskRunId)?.id || null;
    },

    listOutcomesForTaskRun(taskRunId) {
      return db.prepare(`
        SELECT *
        FROM outcomes
        WHERE task_run_id = ?
        ORDER BY is_canonical DESC, evaluated_at DESC, id DESC
      `).all(taskRunId);
    }
  };
}

module.exports = {
  createOutcomesRepository
};
