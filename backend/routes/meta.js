function registerMetaRoutes(app, deps) {
  const {
    EVALUATION_TYPES,
    OUTCOME_LABELS,
    FAILURE_MODES,
    FAILURE_TAXONOMY,
    OUTCOME_LABELS_REQUIRING_FAILURE_MODE
  } = deps;

  app.get('/api/meta/outcome-taxonomy', (_req, res) => {
    res.json({
      evaluation_types: EVALUATION_TYPES,
      outcome_labels: OUTCOME_LABELS,
      failure_modes: FAILURE_MODES,
      failure_taxonomy: FAILURE_TAXONOMY,
      requires_failure_mode_for: [...OUTCOME_LABELS_REQUIRING_FAILURE_MODE]
    });
  });
}

module.exports = {
  registerMetaRoutes
};
