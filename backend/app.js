const express = require('express');
const fs = require('fs');

function createApp({ frontendPath, logger }) {
  const app = express();

  app.use(express.json({ limit: '10mb' }));

  logger.debug('[suboculo] Checking frontend path:', frontendPath);
  logger.debug('[suboculo] Frontend exists?', fs.existsSync(frontendPath));
  if (fs.existsSync(frontendPath)) {
    app.use(express.static(frontendPath, {
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.match(/\.[a-f0-9]{8,}\./)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      }
    }));
    logger.info('[suboculo] Static files enabled from:', frontendPath);
  } else {
    logger.warn('[suboculo] Frontend not found - web UI unavailable');
  }

  return app;
}

module.exports = {
  createApp
};
