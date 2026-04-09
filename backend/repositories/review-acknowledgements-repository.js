function createReviewAcknowledgementsRepository(db) {
  return {
    create({ periodFrom, periodTo, runner, reviewer, acknowledgedAt, notes }) {
      return db.prepare(`
        INSERT INTO review_acknowledgements (
          period_from, period_to, runner, reviewer, acknowledged_at, notes
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(periodFrom, periodTo, runner, reviewer, acknowledgedAt, notes);
    },

    list({ periodFrom, periodTo, runner, limit }) {
      const where = ['1=1'];
      const params = [];

      if (periodFrom) {
        where.push('period_from = ?');
        params.push(periodFrom);
      }
      if (periodTo) {
        where.push('period_to = ?');
        params.push(periodTo);
      }
      if (runner) {
        where.push('runner = ?');
        params.push(runner);
      }

      return db.prepare(`
        SELECT id, period_from, period_to, runner, reviewer, acknowledged_at, notes
        FROM review_acknowledgements
        WHERE ${where.join(' AND ')}
        ORDER BY acknowledged_at DESC, id DESC
        LIMIT ?
      `).all(...params, limit);
    },

    listNullRunner({ periodFrom, periodTo, limit }) {
      const where = ['runner IS NULL'];
      const params = [];

      if (periodFrom) {
        where.push('period_from = ?');
        params.push(periodFrom);
      }
      if (periodTo) {
        where.push('period_to = ?');
        params.push(periodTo);
      }

      return db.prepare(`
        SELECT id, period_from, period_to, runner, reviewer, acknowledged_at, notes
        FROM review_acknowledgements
        WHERE ${where.join(' AND ')}
        ORDER BY acknowledged_at DESC, id DESC
        LIMIT ?
      `).all(...params, limit);
    },

    getLatest({ periodFrom, periodTo, runner }) {
      if (runner) {
        return db.prepare(`
          SELECT id, period_from, period_to, runner, reviewer, acknowledged_at, notes
          FROM review_acknowledgements
          WHERE period_from = ?
            AND period_to = ?
            AND runner = ?
          ORDER BY acknowledged_at DESC, id DESC
          LIMIT 1
        `).get(periodFrom, periodTo, runner) || null;
      }

      return db.prepare(`
        SELECT id, period_from, period_to, runner, reviewer, acknowledged_at, notes
        FROM review_acknowledgements
        WHERE period_from = ?
          AND period_to = ?
          AND runner IS NULL
        ORDER BY acknowledged_at DESC, id DESC
        LIMIT 1
      `).get(periodFrom, periodTo) || null;
    }
  };
}

module.exports = {
  createReviewAcknowledgementsRepository
};
