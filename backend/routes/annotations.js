const {
  parseOrRespond,
  selectionBodySchema,
  tagMutationBodySchema,
  noteMutationBodySchema,
  importBodySchema
} = require('./validation');

function registerAnnotationRoutes(app, deps) {
  const {
    db,
    dbPath,
    fs,
    path,
    logger,
    tryParseJson,
    decodeBase64Fields
  } = deps;

  app.post('/api/selection', (req, res) => {
    try {
      const parsedBody = parseOrRespond(selectionBodySchema, req.body, res);
      if (!parsedBody) return;
      const { keys } = parsedBody;

      const placeholders = keys.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT key, data FROM entries
        WHERE key IN (${placeholders})
        ORDER BY ts ASC
      `).all(...keys);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'No events found for the provided keys' });
      }

      const events = rows.map((row) => {
        const cepEvent = tryParseJson(row.data);
        if (!cepEvent) return null;
        decodeBase64Fields(cepEvent);
        return { __key: row.key, ...cepEvent };
      }).filter(Boolean);

      if (events.length === 0) {
        return res.status(500).json({ error: 'Failed to parse selected event data' });
      }

      const selection = {
        timestamp: new Date().toISOString(),
        count: events.length,
        events
      };

      const selectionPath = path.join(path.dirname(dbPath), 'selection.json');
      fs.writeFileSync(selectionPath, JSON.stringify(selection, null, 2));

      res.json({ success: true, count: events.length });
    } catch (error) {
      logger.error('Save selection error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/selection', (_req, res) => {
    try {
      const selectionPath = path.join(path.dirname(dbPath), 'selection.json');

      if (!fs.existsSync(selectionPath)) {
        return res.json({ timestamp: null, count: 0, events: [] });
      }

      const data = tryParseJson(fs.readFileSync(selectionPath, 'utf-8'));
      if (!data) {
        return res.status(500).json({ error: 'Failed to parse selection file' });
      }
      res.json(data);
    } catch (error) {
      logger.error('Get selection error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/tags', (_req, res) => {
    try {
      const tags = db.prepare('SELECT entry_key, tag FROM tags').all();
      const tagsByKey = {};
      for (const row of tags) {
        if (!tagsByKey[row.entry_key]) {
          tagsByKey[row.entry_key] = [];
        }
        tagsByKey[row.entry_key].push(row.tag);
      }
      res.json(tagsByKey);
    } catch (error) {
      logger.error('Get tags error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/tags', (req, res) => {
    try {
      const parsedBody = parseOrRespond(tagMutationBodySchema, req.body, res);
      if (!parsedBody) return;
      const { entryKey, tag, action } = parsedBody;

      if (action === 'add') {
        db.prepare('INSERT OR IGNORE INTO tags (entry_key, tag) VALUES (?, ?)').run(entryKey, tag);
      } else if (action === 'remove') {
        db.prepare('DELETE FROM tags WHERE entry_key = ? AND tag = ?').run(entryKey, tag);
      }

      res.json({ success: true });
    } catch (error) {
      logger.error('Tag operation error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/notes', (_req, res) => {
    try {
      const notes = db.prepare('SELECT entry_key, note FROM notes').all();
      const notesByKey = {};
      for (const row of notes) {
        notesByKey[row.entry_key] = row.note;
      }
      res.json(notesByKey);
    } catch (error) {
      logger.error('Get notes error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/notes', (req, res) => {
    try {
      const parsedBody = parseOrRespond(noteMutationBodySchema, req.body, res);
      if (!parsedBody) return;
      const { entryKey, note } = parsedBody;

      if (note && note.trim()) {
        db.prepare('INSERT OR REPLACE INTO notes (entry_key, note) VALUES (?, ?)').run(entryKey, note);
      } else {
        db.prepare('DELETE FROM notes WHERE entry_key = ?').run(entryKey);
      }

      res.json({ success: true });
    } catch (error) {
      logger.error('Note operation error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/export', (_req, res) => {
    try {
      const tags = db.prepare('SELECT entry_key, tag FROM tags').all();
      const notes = db.prepare('SELECT entry_key, note FROM notes').all();

      const tagsByKey = {};
      for (const row of tags) {
        if (!tagsByKey[row.entry_key]) {
          tagsByKey[row.entry_key] = [];
        }
        tagsByKey[row.entry_key].push(row.tag);
      }

      const notesByKey = {};
      for (const row of notes) {
        notesByKey[row.entry_key] = row.note;
      }

      res.json({
        exportedAt: new Date().toISOString(),
        tagsByKey,
        notesByKey
      });
    } catch (error) {
      logger.error('Export error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/import', (req, res) => {
    try {
      const parsedBody = parseOrRespond(importBodySchema, req.body, res);
      if (!parsedBody) return;
      const { tagsByKey, notesByKey } = parsedBody;

      const insertTag = db.prepare('INSERT OR IGNORE INTO tags (entry_key, tag) VALUES (?, ?)');
      const insertNote = db.prepare('INSERT OR REPLACE INTO notes (entry_key, note) VALUES (?, ?)');

      const importAll = db.transaction(() => {
        db.exec('DELETE FROM tags');
        db.exec('DELETE FROM notes');

        if (tagsByKey) {
          for (const [key, tags] of Object.entries(tagsByKey)) {
            for (const tag of tags) {
              insertTag.run(key, tag);
            }
          }
        }

        if (notesByKey) {
          for (const [key, note] of Object.entries(notesByKey)) {
            insertNote.run(key, note);
          }
        }
      });

      importAll();
      res.json({ success: true });
    } catch (error) {
      logger.error('Import error:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = {
  registerAnnotationRoutes
};
