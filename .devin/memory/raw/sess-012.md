# Session Capture — 2026-08-26 — sess-012

## Context
- Task: Dashboard serverless mode — graceful UI degradation for Cloudflare Worker
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
- Worker /health returns serverless: true — use this to detect serverless mode in the dashboard
- useServerlessMode hook caches at module scope to avoid re-fetching /health across components
- Worker missing endpoints: /admins (all), /devices/:id/pba-credentials, /installer/:id, /installer/:id/nsis, DELETE /devices/:id/release
- Worker /health/detailed returns {status, serverless, devices, pending_commands, timestamp} — no server/db/fleet/alerts fields, would crash HealthPage
- Vitest test files with JSX must use .jsx extension, not .js (Vite import analysis rejects JSX in .js)
- .env file sets VITE_API_URL to the Worker URL — client.test.js must account for this

## Mistakes / Corrections
- mistake: named useCurrentUser test file .test.js but it contains JSX wrapper — Vite rejected it. Fixed by renaming to .test.jsx
- mistake: client test expected baseURL /api but .env sets VITE_API_URL — fixed by testing with actual env value + stubbed env test

## Open Questions
- <none recorded>

## File References
- dashboard/src/hooks/useServerlessMode.js
- dashboard/src/components/DashboardLayout.jsx
- dashboard/src/pages/AdminsPage.jsx
- dashboard/src/pages/DeviceDetailPage.jsx
- dashboard/src/pages/EnrollPage.jsx
- dashboard/src/pages/HealthPage.jsx
- dashboard/src/api/client.js
- dashboard/src/hooks/useCurrentUser.js
- dashboard/src/pages/LoginPage.jsx
- dashboard/tests/useServerlessMode.test.js
- dashboard/tests/useCurrentUser.test.jsx
- dashboard/tests/client.test.js
- .devin/graph/trace.md
- .devin/graph/current-state.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
