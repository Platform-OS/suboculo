const {
  parseOrRespond,
  analysisIdParamsSchema,
  analysesCreateBodySchema,
  analyzeBodySchema
} = require('./validation');

function registerAnalysesRoutes(app, deps) {
  const {
    db,
    logger,
    tryParseJson,
    callAnthropicAPI
  } = deps;

  app.get('/api/analyses-history', (_req, res) => {
    try {
      const analyses = db.prepare(`
        SELECT id, timestamp, model, event_count, analysis, prompt
        FROM analyses
        ORDER BY timestamp DESC
      `).all();

      res.json(analyses);
    } catch (error) {
      logger.error('Get analyses error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/analyses-history/:id', (req, res) => {
    try {
      const params = parseOrRespond(analysisIdParamsSchema, req.params, res);
      if (!params) return;

      const analysis = db.prepare('SELECT * FROM analyses WHERE id = ?').get(params.id);
      if (!analysis) {
        return res.status(404).json({ error: 'Analysis not found' });
      }

      analysis.event_keys = tryParseJson(analysis.event_keys);
      if (!analysis.event_keys) {
        return res.status(500).json({ error: 'Failed to parse saved analysis event keys' });
      }
      res.json(analysis);
    } catch (error) {
      logger.error('Get analysis error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/analyses', (req, res) => {
    try {
      const parsedBody = parseOrRespond(analysesCreateBodySchema, req.body, res);
      if (!parsedBody) return;
      const { model, event_count, event_keys, analysis, prompt } = parsedBody;

      const analysisId = db.prepare(`
        INSERT INTO analyses (timestamp, model, event_count, event_keys, analysis, prompt)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        new Date().toISOString(),
        model || 'claude-code-cli',
        event_count || 0,
        JSON.stringify(event_keys || []),
        analysis,
        prompt || null
      ).lastInsertRowid;

      res.json({ success: true, analysisId });
    } catch (error) {
      logger.error('Save analysis error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/analyses-history/:id', (req, res) => {
    try {
      const params = parseOrRespond(analysisIdParamsSchema, req.params, res);
      if (!params) return;

      db.prepare('DELETE FROM analyses WHERE id = ?').run(params.id);
      res.json({ success: true });
    } catch (error) {
      logger.error('Delete analysis error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/analyze', async (req, res) => {
    try {
      const parsedBody = parseOrRespond(analyzeBodySchema, req.body, res);
      if (!parsedBody) return;
      const { keys, model, apiKey, prompt } = parsedBody;

      const placeholders = keys.map(() => '?').join(',');
      const events = db.prepare(`
        SELECT data FROM entries
        WHERE key IN (${placeholders})
        ORDER BY ts ASC
      `).all(...keys);

      if (events.length === 0) {
        return res.status(404).json({ error: 'No events found' });
      }

      const parsedEvents = events
        .map((row) => tryParseJson(row.data))
        .filter(Boolean);

      if (parsedEvents.length === 0) {
        return res.status(500).json({ error: 'Failed to parse selected events' });
      }

      const eventsText = parsedEvents.map((e, i) => `Event ${i + 1}:
- Time: ${e.ts}
- Type: ${e.event}
- Runner: ${e.runner}
- Tool: ${e.data?.tool || 'N/A'}
- Status: ${e.data?.status || 'N/A'}
- Duration: ${e.data?.durationMs ? `${e.data.durationMs}ms` : 'N/A'}
- Args: ${JSON.stringify(e.data?.args || {}, null, 2)}`).join('\n\n');

      const systemPrompt = prompt || `You are an AI agent behavior analyst. Analyze the following sequence of agent tool executions and provide insights about:
1. What the agent was trying to accomplish
2. Efficiency and performance patterns
3. Any potential issues or improvements
4. Overall workflow assessment

Be concise and actionable.`;

      const userMessage = `Analyze these ${parsedEvents.length} agent events:\n\n${eventsText}`;
      const resolvedModel = model || 'claude-sonnet-4-6';
      const analysis = await callAnthropicAPI(resolvedModel, systemPrompt, userMessage, apiKey);

      const analysisId = db.prepare(`
        INSERT INTO analyses (timestamp, model, event_count, event_keys, analysis, prompt)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        new Date().toISOString(),
        resolvedModel,
        parsedEvents.length,
        JSON.stringify(keys),
        analysis,
        prompt || null
      ).lastInsertRowid;

      res.json({
        success: true,
        analysis,
        eventCount: parsedEvents.length,
        model: resolvedModel,
        provider: 'anthropic',
        analysisId
      });
    } catch (error) {
      logger.error('Analysis error:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = {
  registerAnalysesRoutes
};
