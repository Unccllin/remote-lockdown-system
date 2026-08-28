# Session Capture — 2026-08-28 — sess-019

## Context
- Task: Implemented dual-mode Electron app: first-run setup wizard chooses Local Server (bundled Express+SQLite) or Cloud Serverless (Cloudflare Worker). One installer supports both modes. Dashboard API URL is now runtime-configurable via Electron preload IPC.
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- <none recorded>

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- electron/config.js: added mode ('local'|'serverless'|null) + serverless_worker_url fields. saveMode() and updateConfig() functions. initConfig() backfills mode:null for pre-existing configs (triggers wizard on next launch).
- electron/setup-wizard.js + setup.html + setup-preload.js (NEW): first-run setup wizard with mode selection cards + Worker URL input with debounced validation (fetches /health, checks serverless:true). validateWorkerUrl() tries root /health and /api/health with 5s timeout.
- electron/main.js: branches on config.mode. Serverless: sets ELECTRON_API_BASE_URL env var, calls startStaticServer(). Local: sets SQLITE_PATH, calls startServer() (current behavior).
- electron/server-starter.js: added startStaticServer() — serves only static files + SPA fallback, no API routes/database. Used in serverless mode (BrowserRouter requires HTTP, can't use file://).
- electron/preload.js: exposes apiBaseUrl on window.electronApp (reads ELECTRON_API_BASE_URL env var, null in local mode).
- dashboard/src/api/client.js: baseURL priority is now (1) window.electronApp.apiBaseUrl [runtime], (2) VITE_API_URL [build-time], (3) /api [same-origin].
- 72 dashboard tests pass (+3 new client.test.js tests for runtime URL). Vite build succeeds. All electron .js pass node --check.

## Mistakes / Corrections
- No failures this session. All changes passed on first attempt.

## Open Questions
- <none recorded>

## File References
- electron/config.js
- electron/main.js
- electron/preload.js
- electron/setup-preload.js
- electron/setup-wizard.js
- electron/setup.html
- electron/server-starter.js
- electron/package.json
- dashboard/src/api/client.js
- dashboard/tests/client.test.js
- .devin/graph/GRAPH-SPEC.yaml
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
