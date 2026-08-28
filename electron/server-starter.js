/**
 * server-starter.js — static file server for the Electron admin app.
 *
 * The Electron app is a serverless desktop shell. All API calls go to a
 * Cloudflare Worker. This module starts a minimal Express server that
 * serves ONLY the built dashboard UI (static files + SPA fallback).
 *
 * Why a local server at all? BrowserRouter (used by the dashboard) requires
 * an HTTP origin — file:// doesn't support the History API. So we start a
 * tiny static server on a random port, and the dashboard's API calls go
 * cross-origin to the Worker (which has CORS Access-Control-Allow-Origin: *).
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

/**
 * Start a static-only server that serves the dashboard UI.
 *
 * @param {object} options
 * @param {string} options.dashboardDistPath — path to dashboard/dist (built dashboard)
 * @returns {Promise<{ server: object, port: number }>}
 */
async function startStaticServer(options = {}) {
  const { dashboardDistPath = null } = options;

  if (!dashboardDistPath || !fs.existsSync(dashboardDistPath)) {
    throw new Error('Dashboard dist path is required. Fix: build the dashboard first with `cd dashboard && npx vite build`, then ensure the path is passed to startStaticServer.');
  }

  const app = express();
  const indexPath = path.resolve(dashboardDistPath, 'index.html');

  app.use(express.static(dashboardDistPath, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  // SPA fallback: serve index.html for any route (client-side routing)
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(indexPath);
  });

  const port = parseInt(process.env.PORT || '0');
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const actualPort = server.address().port;
      console.log(`[server-starter] Static server running on http://localhost:${actualPort} (API calls go to Worker)`);
      resolve({ server, port: actualPort });
    });
    server.on('error', reject);
  });
}

module.exports = { startStaticServer };
