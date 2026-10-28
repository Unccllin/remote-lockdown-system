# Session Capture — 2026-10-28 — sess-148

## Context
- Task: Answer what the k6 admin token is and run the mixed load scenario with it
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
- K6_ADMIN_TOKEN is the application JWT (Authorization: Bearer) for /api/devices and /api/audit — not SSH/root; it can be minted against a throwaway DB via POST /api/setup/create-admin then POST /api/auth/login
- /api/setup/create-admin creates only the FIRST admin and 403s permanently afterwards, which makes it safe-but-single-use for test DBs
- k6-mixed measured signed: 100 VUs/60s = 5,357 req, 88 req/s, p95 72ms, 0% failures, 11 checks green

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- docs/LOAD_TESTING.md
- tests/load/results/k6-mixed-signed-dl380p-20261028.json

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
