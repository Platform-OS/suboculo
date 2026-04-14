const {
  parseOrRespond,
  eventBodySchema,
  eventBatchBodySchema
} = require('./validation');

function registerRuntimeRoutes(app, deps) {
  const {
    db,
    logger,
    sseEmitter,
    tryParseJson,
    decodeBase64Fields,
    sseKey,
    validateCEPEvent,
    insertCEPEvent,
    insertCEPEventsBatch,
    upsertTaskRunForRootSession
  } = deps;

  app.post('/api/notify', (req, res) => {
    try {
      const event = parseOrRespond(eventBodySchema, req.body, res);
      if (!event) return;

      if (event.event === 'tool.end' && event.traceId) {
        try {
          const startEvent = db.prepare(`
            SELECT data FROM entries
            WHERE traceId = ? AND event = 'tool.start'
            ORDER BY ts DESC LIMIT 1
          `).get(event.traceId);

          if (startEvent) {
            const startData = tryParseJson(startEvent.data);
            if (startData?.ts) {
              const startTime = new Date(startData.ts);
              const endTime = new Date(event.ts);
              const durationMs = endTime - startTime;
              if (!event.data) event.data = {};
              event.data.durationMs = durationMs;
              event.data.durationSource = 'derived_hook_timestamps';
            }
          }
        } catch (err) {
          logger.warn('Failed to calculate duration:', err.message);
        }
      }

      decodeBase64Fields(event);
      sseEmitter.emit('event', {
        __key: sseKey(event),
        ...event
      });

      res.json({ success: true });
    } catch (error) {
      logger.error('Notify error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/notify/batch', (req, res) => {
    try {
      const events = parseOrRespond(eventBatchBodySchema, req.body, res);
      if (!events) return;

      let emitted = 0;
      for (const event of events) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
        decodeBase64Fields(event);
        sseEmitter.emit('event', { __key: sseKey(event), ...event });
        emitted++;
      }

      res.json({ success: true, received: events.length, emitted });
    } catch (error) {
      logger.error('Batch notify error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ingest', (req, res) => {
    try {
      const event = parseOrRespond(eventBodySchema, req.body, res);
      if (!event) return;

      const validation = validateCEPEvent(event);
      if (!validation.valid) {
        return res.status(400).json({
          error: 'Invalid CEP event',
          details: validation.errors
        });
      }

      if (event.event === 'tool.end' && event.traceId) {
        try {
          const startEvent = db.prepare(`
            SELECT data FROM entries
            WHERE traceId = ? AND event = 'tool.start'
            ORDER BY ts DESC LIMIT 1
          `).get(event.traceId);

          if (startEvent) {
            const startData = tryParseJson(startEvent.data);
            if (startData?.ts) {
              const startTime = new Date(startData.ts);
              const endTime = new Date(event.ts);
              const durationMs = endTime - startTime;
              if (!event.data) event.data = {};
              event.data.durationMs = durationMs;
              event.data.durationSource = 'derived_hook_timestamps';
            }
          }
        } catch (err) {
          logger.warn('Failed to calculate duration:', err.message);
        }
      }

      const key = insertCEPEvent(db, event);
      upsertTaskRunForRootSession(event.parentSessionId || event.sessionId);

      sseEmitter.emit('event', {
        __key: key,
        ...event
      });

      res.json({
        success: true,
        key,
        event: event.event
      });
    } catch (error) {
      logger.error('Ingest error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ingest/batch', (req, res) => {
    try {
      const events = parseOrRespond(eventBatchBodySchema, req.body, res);
      if (!events) return;

      const invalidEvents = [];
      for (let i = 0; i < events.length; i++) {
        const validation = validateCEPEvent(events[i]);
        if (!validation.valid) {
          invalidEvents.push({
            index: i,
            errors: validation.errors
          });
        }
      }

      if (invalidEvents.length > 0) {
        return res.status(400).json({
          error: 'Some events are invalid',
          invalidEvents: invalidEvents.slice(0, 10)
        });
      }

      const count = insertCEPEventsBatch(db, events);
      const rootSessions = [...new Set(events.map((event) => event.parentSessionId || event.sessionId).filter(Boolean))];
      for (const rootSessionId of rootSessions) {
        upsertTaskRunForRootSession(rootSessionId);
      }

      events.forEach((event) => {
        sseEmitter.emit('event', {
          __key: sseKey(event),
          ...event
        });
      });

      res.json({
        success: true,
        count,
        total: events.length
      });
    } catch (error) {
      logger.error('Batch ingest error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  logger.debug('[INIT] Registering SSE endpoint at /api/events/stream');
  app.get('/api/events/stream', (req, res) => {
    logger.debug('[SSE] Client connecting to stream');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    res.write(': connected\n\n');

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30000);

    const listener = (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (err) {
        logger.error('SSE write error:', err.message);
      }
    };

    sseEmitter.on('event', listener);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseEmitter.off('event', listener);
      logger.debug('SSE client disconnected');
    });

    logger.debug('SSE client connected');
  });
}

module.exports = {
  registerRuntimeRoutes
};
