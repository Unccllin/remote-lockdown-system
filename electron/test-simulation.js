/**
 * test-simulation.js — Simulates the Electron app without Electron.
 *
 * Does what main.js + preload.js do, but in plain Node:
 *   1. Starts the static server (serves dashboard/dist)
 *   2. Injects window.electronApp.apiBaseUrl into the dashboard HTML
 *   3. Serves setup.html at /setup (for testing the wizard UI)
 *   4. Opens the dashboard in the browser
 *
 * Usage: node test-simulation.js [worker-url]
 * Default worker URL: https://lockdown-serverless.mainacollins196.workers.dev/api
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

const WORKER_URL = process.argv[2] || 'https://lockdown-serverless.mainacollins196.workers.dev/api';
const DASHBOARD_DIST = path.join(__dirname, '..', 'dashboard', 'dist');

if (!fs.existsSync(path.join(DASHBOARD_DIST, 'index.html'))) {
  console.error('Dashboard not built. Run: cd dashboard && npx vite build');
  process.exit(1);
}

const app = express();
const indexPath = path.resolve(DASHBOARD_DIST, 'index.html');

// Read the original index.html and inject the electronApp script
let indexHtml = fs.readFileSync(indexPath, 'utf8');
const injectionScript = `<script>window.electronApp={apiBaseUrl:"${WORKER_URL}",isElectron:false,platform:"simulation"};</script>`;
indexHtml = indexHtml.replace('</head>', `${injectionScript}\n</head>`);

// Serve static assets (everything except index.html — we serve a modified version)
app.use(express.static(DASHBOARD_DIST, {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// Serve the modified index.html (with Worker URL injected) at root + SPA routes
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html');
  res.send(indexHtml);
});

// Serve setup.html at /setup
app.get('/setup', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'setup.html'));
});

// SPA fallback — serve modified index.html for all other routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found (simulation — API calls go to the Worker)' });
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html');
  res.send(indexHtml);
});

const PORT = 18888;
const server = app.listen(PORT, () => {
  console.log('\n========================================');
  console.log('  Electron App Simulation (no Electron)');
  console.log('========================================');
  console.log(`\n  Worker URL: ${WORKER_URL}`);
  console.log(`\n  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Setup wizard: http://localhost:${PORT}/setup`);
  console.log('\n  The dashboard has window.electronApp.apiBaseUrl injected,');
  console.log('  so all API calls go to the Cloudflare Worker.');
  console.log('\n  Press Ctrl+C to stop.\n');
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
