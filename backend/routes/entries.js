const { parseOrRespond, entriesQuerySchema } = require('./validation');

function registerEntriesRoutes(app, deps) {
  const {
    db,
    logger,
    tryParseJson,
    decodeBase64Fields
  } = deps;

  app.get('/api/entries', (req, res) => {
    try {
      const parsedQuery = parseOrRespond(entriesQuerySchema, req.query, res);
      if (!parsedQuery) return;

      const {
        page = 1,
        pageSize = 100,
        kind,
        type,
        tool,
        subagent,
        rootSession,
        tag,
        query,
        sortKey = 'ts',
        sortDir = 'desc',
        runner,
        event,
        attempt
      } = parsedQuery;

      let sql = `
        SELECT
          e.*,
          tr.id AS taskRunId,
          tr.task_key AS attemptKey
        FROM entries e
        LEFT JOIN task_run_events tre ON tre.entry_key = e.key
        LEFT JOIN task_runs tr ON tr.id = tre.task_run_id
        WHERE 1=1
      `;
      const params = [];

      if (runner && runner !== 'all') {
        sql += ' AND e.runner = ?';
        params.push(runner);
      }

      if (event && event !== 'all') {
        sql += ' AND e.event = ?';
        params.push(event);
      }

      if (attempt && attempt !== 'all') {
        sql += ' AND tr.task_key = ?';
        params.push(attempt);
      }

      if (kind && kind !== 'all') {
        sql += ' AND (e.kind = ? OR e.event = ?)';
        params.push(kind, kind);
      }

      if (type && type !== 'all') {
        sql += ' AND e.type = ?';
        params.push(type);
      }

      if (tool && tool !== 'all') {
        sql += ' AND e.tool = ?';
        params.push(tool);
      }

      if (subagent && subagent !== 'all') {
        sql += ' AND e.subagentType = ?';
        params.push(subagent);
      }

      if (rootSession && rootSession !== 'all') {
        sql += ' AND e.rootSessionID = ?';
        params.push(rootSession);
      }

      if (tag && tag !== 'all') {
        sql += ' AND e.key IN (SELECT entry_key FROM tags WHERE tag = ?)';
        params.push(tag);
      }

      if (query) {
        sql += ` AND (
          e.kind LIKE ? OR
          e.type LIKE ? OR
          e.tool LIKE ? OR
          e.sessionID LIKE ? OR
          e.rootSessionID LIKE ? OR
          e.callID LIKE ? OR
          e.title LIKE ? OR
          e.outputPreview LIKE ? OR
          e.args LIKE ? OR
          tr.task_key LIKE ? OR
          e.key IN (SELECT entry_key FROM tags WHERE tag LIKE ?) OR
          e.key IN (SELECT entry_key FROM notes WHERE note LIKE ?)
        )`;
        const likeQuery = `%${query}%`;
        params.push(...Array(12).fill(likeQuery));
      }

      const countSql = sql.replace(
        `SELECT
          e.*,
          tr.id AS taskRunId,
          tr.task_key AS attemptKey`,
        'SELECT COUNT(DISTINCT e.key) as count'
      );
      const countResult = db.prepare(countSql).get(...params);
      const total = countResult.count;

      const allowedSortKeys = ['ts', 'kind', 'tool', 'durationMs'];
      const safeSortKey = allowedSortKeys.includes(sortKey) ? sortKey : 'ts';
      const safeSortDir = sortDir === 'asc' ? 'ASC' : 'DESC';
      sql += ` GROUP BY e.key ORDER BY e.${safeSortKey} ${safeSortDir}`;

      const limit = parseInt(pageSize, 10);
      const offset = (parseInt(page, 10) - 1) * limit;
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const entries = db.prepare(sql).all(...params);
      const parsedEntries = entries.map((row) => {
        const cepEvent = tryParseJson(row.data);
        if (!cepEvent) return null;

        if (!cepEvent.data) cepEvent.data = {};
        if (row.durationMs != null && cepEvent.data.durationMs == null) {
          cepEvent.data.durationMs = row.durationMs;
        }
        if (row.status && !cepEvent.data.status) {
          cepEvent.data.status = row.status;
        }

        decodeBase64Fields(cepEvent);

        return {
          __key: row.key,
          taskRunId: row.taskRunId || null,
          attemptKey: row.attemptKey || null,
          ...cepEvent
        };
      }).filter(Boolean);

      res.json({
        entries: parsedEntries,
        total,
        page: parseInt(page, 10),
        pageSize: limit,
        totalPages: Math.ceil(total / limit)
      });
    } catch (error) {
      logger.error('Query error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/facets', (_req, res) => {
    try {
      const kinds = db.prepare('SELECT DISTINCT kind FROM entries WHERE kind IS NOT NULL ORDER BY kind').all();
      const types = db.prepare('SELECT DISTINCT type FROM entries WHERE type IS NOT NULL ORDER BY type').all();
      const tools = db.prepare('SELECT DISTINCT tool FROM entries WHERE tool IS NOT NULL ORDER BY tool').all();
      const subagents = db.prepare('SELECT DISTINCT subagentType FROM entries WHERE subagentType IS NOT NULL ORDER BY subagentType').all();
      const roots = db.prepare('SELECT DISTINCT rootSessionID FROM entries WHERE rootSessionID IS NOT NULL').all();
      const allTags = db.prepare('SELECT DISTINCT tag FROM tags ORDER BY tag').all();
      const runners = db.prepare('SELECT DISTINCT runner FROM entries WHERE runner IS NOT NULL ORDER BY runner').all();
      const events = db.prepare('SELECT DISTINCT event FROM entries WHERE event IS NOT NULL ORDER BY event').all();
      const attempts = db.prepare(`
        SELECT DISTINCT task_key
        FROM task_runs
        WHERE source = 'derived_attempt'
        ORDER BY started_at DESC, task_key DESC
      `).all();

      res.json({
        kinds: kinds.map((r) => r.kind),
        types: types.map((r) => r.type),
        tools: tools.map((r) => r.tool),
        subagents: subagents.map((r) => r.subagentType),
        roots: roots.map((r) => r.rootSessionID),
        allTags: allTags.map((r) => r.tag),
        runners: runners.map((r) => r.runner),
        events: events.map((r) => r.event),
        attempts: attempts.map((r) => r.task_key)
      });
    } catch (error) {
      logger.error('Facets error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/stats', (_req, res) => {
    try {
      const total = db.prepare('SELECT COUNT(*) as count FROM entries').get();
      const avgDur = db.prepare(`
        SELECT AVG(durationMs) as avg
        FROM entries
        WHERE event = 'tool.end' AND durationMs IS NOT NULL
      `).get();

      res.json({
        total: total.count,
        avgDur: avgDur.avg ? Math.round(avgDur.avg) : null
      });
    } catch (error) {
      logger.error('Stats error:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = {
  registerEntriesRoutes
};
