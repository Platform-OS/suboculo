const { existsSync, openSync, readSync, closeSync, statSync } = require('fs');

const {
  parseOrRespond,
  eventBodySchema,
  eventBatchBodySchema
} = require('./validation');

function seekPastNewline(fd, byteOffset, fileSize, buf) {
  let pos = byteOffset;
  while (pos < fileSize) {
    const toRead = Math.min(buf.length, fileSize - pos);
    const bytesRead = readSync(fd, buf, 0, toRead, pos);
    if (bytesRead === 0) return fileSize;
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0x0A) return pos + i + 1;
    }
    pos += bytesRead;
  }
  return fileSize;
}

function readLineAt(fd, offset, fileSize, buf) {
  if (offset >= fileSize) return { line: null, nextOffset: fileSize };
  let result = '';
  let pos = offset;
  while (pos < fileSize) {
    const toRead = Math.min(buf.length, fileSize - pos);
    const bytesRead = readSync(fd, buf, 0, toRead, pos);
    if (bytesRead === 0) break;
    const chunk = buf.toString('utf8', 0, bytesRead);
    const nlIdx = chunk.indexOf('\n');
    if (nlIdx !== -1) {
      result += chunk.substring(0, nlIdx);
      return { line: result, nextOffset: pos + nlIdx + 1 };
    }
    result += chunk;
    pos += bytesRead;
  }
  return { line: result || null, nextOffset: fileSize };
}

const TS_RE = /"timestamp":"([^"]+)"/;
function extractTimestamp(line) {
  const m = TS_RE.exec(line);
  return m ? m[1] : null;
}

function diffMs(startTs, endTs) {
  if (!startTs || !endTs) return null;
  const start = new Date(startTs);
  const end = new Date(endTs);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return end - start;
}

function findOffsetByTimestamp(filePath, targetTs) {
  const { size: fileSize } = statSync(filePath);
  if (fileSize === 0) return 0;

  let fd;
  const buf = Buffer.alloc(8192);
  const target = new Date(new Date(targetTs).getTime() - 2000).toISOString();

  try {
    fd = openSync(filePath, 'r');

    let lo = 0;
    let hi = fileSize;
    let bestOffset = fileSize;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const lineStart = mid === 0 ? 0 : seekPastNewline(fd, mid, fileSize, buf);

      if (lineStart >= fileSize) {
        hi = mid;
        continue;
      }

      const { line, nextOffset } = readLineAt(fd, lineStart, fileSize, buf);
      if (!line) {
        hi = mid;
        continue;
      }

      const ts = extractTimestamp(line);
      if (!ts || ts < target) {
        lo = nextOffset;
      } else {
        hi = mid;
        bestOffset = lineStart;
      }
    }

    return bestOffset;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readClaudeMcpTimingFromTranscript(transcriptPath, traceId, endTs) {
  if (!transcriptPath || !traceId || !endTs || !existsSync(transcriptPath)) return null;

  const { size: fileSize } = statSync(transcriptPath);
  if (fileSize === 0) return null;

  const offset = findOffsetByTimestamp(
    transcriptPath,
    new Date(new Date(endTs).getTime() - 60000).toISOString()
  );
  const upperTs = new Date(new Date(endTs).getTime() + 5000).toISOString();
  const buf = Buffer.alloc(64 * 1024);
  let fd;
  let startedAt = null;
  let completedAt = null;
  let elapsedTimeMs = null;

  try {
    fd = openSync(transcriptPath, 'r');
    let pos = offset;

    while (pos < fileSize) {
      const { line, nextOffset } = readLineAt(fd, pos, fileSize, buf);
      if (!line) break;
      pos = nextOffset;

      const ts = extractTimestamp(line);
      if (ts && ts > upperTs) break;

      if (!line.includes(traceId)) continue;
      if (!line.includes('"mcp_progress"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry?.type !== 'progress') continue;
      if (entry?.toolUseID !== traceId && entry?.parentToolUseID !== traceId) continue;

      const data = entry.data || {};
      if (data.type !== 'mcp_progress') continue;
      if (data.status === 'started' && !startedAt) {
        startedAt = entry.timestamp || ts || null;
        continue;
      }
      if (data.status !== 'completed') continue;

      completedAt = entry.timestamp || ts || null;
      const elapsed = data.elapsedTimeMs;
      if (typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0) {
        elapsedTimeMs = elapsed;
      }
      if (completedAt && elapsedTimeMs != null) {
        break;
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  if (!startedAt && completedAt && elapsedTimeMs != null) {
    startedAt = new Date(new Date(completedAt).getTime() - elapsedTimeMs).toISOString();
  }

  if (!startedAt && !completedAt && elapsedTimeMs == null) return null;

  return {
    runnerStartedAt: startedAt,
    runnerCompletedAt: completedAt,
    runnerElapsedMs: elapsedTimeMs ?? diffMs(startedAt, completedAt)
  };
}

function attachBestDuration(event, db, tryParseJson) {
  if (event.event !== 'tool.end' || !event.traceId) return;

  if (!event.data) event.data = {};
  if (typeof event.data.durationMs === 'number' && !event.data.durationSource) {
    event.data.durationSource = 'reported_by_runner';
    event.data.durationKind = 'reported_elapsed';
    return;
  }
  if (typeof event.data.durationMs === 'number') return;

  let hookStartedAt = null;
  let runnerTiming = null;

  try {
    runnerTiming = readClaudeMcpTimingFromTranscript(
      event.data.transcriptPath,
      event.traceId,
      event.ts
    );
    if (runnerTiming?.runnerElapsedMs != null) {
      event.data.durationMs = runnerTiming.runnerElapsedMs;
      event.data.durationSource = 'reported_by_runner';
    }
  } catch {
    // fall through to hook-paired timing
  }

  try {
    const startEvent = db.prepare(`
      SELECT data FROM entries
      WHERE traceId = ? AND event = 'tool.start'
      ORDER BY ts DESC LIMIT 1
    `).get(event.traceId);

    if (startEvent) {
      const startData = tryParseJson(startEvent.data);
      if (startData?.ts) {
        hookStartedAt = startData.ts;
        const startTime = new Date(startData.ts);
        const endTime = new Date(event.ts);
        if (event.data.durationMs == null) {
          event.data.durationMs = endTime - startTime;
          event.data.durationSource = 'derived_hook_timestamps';
        }
      }
    }
  } catch {
    // non-fatal
  }

  if (!hookStartedAt) {
    try {
      const startRow = db.prepare(`
        SELECT ts FROM entries
        WHERE traceId = ? AND event = 'tool.start'
        ORDER BY ts DESC LIMIT 1
      `).get(event.traceId);
      hookStartedAt = startRow?.ts || null;
    } catch {
      // non-fatal
    }
  }

  const timingBreakdown = {
    hookStartedAt,
    hookCompletedAt: event.ts || null,
    runnerStartedAt: runnerTiming?.runnerStartedAt || null,
    runnerCompletedAt: runnerTiming?.runnerCompletedAt || null,
    hookWallTimeMs: diffMs(hookStartedAt, event.ts),
    runnerElapsedMs: runnerTiming?.runnerElapsedMs ?? null,
    preRunnerOverheadMs: diffMs(hookStartedAt, runnerTiming?.runnerStartedAt),
    postRunnerOverheadMs: diffMs(runnerTiming?.runnerCompletedAt, event.ts)
  };
  if (Object.values(timingBreakdown).some((value) => value != null)) {
    event.data.timingBreakdown = timingBreakdown;
  }
  event.data.durationKind = event.data.durationSource === 'reported_by_runner' && runnerTiming?.runnerElapsedMs != null
    ? 'mcp_roundtrip'
    : 'hook_wall_time';
}

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

      attachBestDuration(event, db, tryParseJson);

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

      attachBestDuration(event, db, tryParseJson);

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
