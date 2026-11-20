# Session Capture — 2026-11-18 — sess-299

## Context
- Task: S300: establish what state the dashboard is actually in and make it demoable
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
- dashboard E2E failures were a missing Playwright browser (~/.cache/ms-playwright/chromium_headless_shell-1234), not a regression; after 'npx playwright install chromium-headless-shell' the suite is 11/11 green. The one repeated error line naming the executable path is the tell.
- dashboard/dist was 3 source files stale; vite build refreshes it (assets/index-BiqBoQfX.js, 640 kB).
- server/dev-start-sqlite.js never served the SPA (only /api and /metrics), unlike server/src/index.js; it now mounts dashboard/dist with the same cache rules and SPA fallback, verified live.
- Client base URL is electronApiUrl || VITE_API_URL || '/api' — same-origin by default; a Worker-pointed dashboard needs VITE_API_URL at build time (no dashboard/.env exists).

## Mistakes / Corrections
- mistake: the 11/11 E2E failure reads like a broken product; correction: read the single repeated error line before believing the summary count.

## Open Questions
- <none recorded>

## File References
- server/dev-start-sqlite.js
- docs/artifacts/s300-dashboard-state.txt
- dashboard/dist (rebuilt)

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
