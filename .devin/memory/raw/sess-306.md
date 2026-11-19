# Session Capture — 2026-11-19 — sess-306

## Context
- Task: Sweep make full-verify end to end (S307) and attribute every red
- Environment: repo remote-lockdown-system; docker.sock root:docker 0660, no docker group, sudo -n needs password; playwright 11 tests
- Duration: <not specified>

## Decisions Made
- record the tls-floor red as NOT PASSED, never as a SKIP (repo rule: a gate that cannot run has not passed)
- fix reuseExistingServer rather than document a workaround: opt-in via PLAYWRIGHT_REUSE_DEV_SERVER
- AGENTS.md split into re-measured today / cannot-pass-here / NOT re-measured with older dates

## Actions Taken
- ran make full-verify (graph-check, lint, 6 suites, scripts); chain aborted at test-scripts
- ran test-e2e 14/14, verify-env 56/0/5, check-artifacts by hand
- ran Playwright: 7 failed; found stale vite on 5173 from S303; killed it; 11 passed
- proved the new config fails loudly with a dummy listener on 5173
- committed 36defcb + docs/artifacts/s307-full-verify.txt

## Outcomes
- What worked: - ps -o lstart dated the stale server to S303, which made the attribution conclusive
- testing the fix's failure mode (dummy listener) proved the claim instead of asserting it
- What failed: - I called the Playwright red 'genuine, not a flake' before checking the environment; it was neither
- What was unexpected: - make full-verify does NOT include Playwright test-e2e-dashboard, so 'full verify' omits a whole suite
- a single suite failing aborts the chain, so three steps never ran and had to be run by hand
- bg_run's exit code was 0 for a failing suite because a trailing echo masked PIPESTATUS

## Learnings
- a Playwright run that reuses an existing dev server tests whatever is on that port; check ss/ps before believing a red
- when a make chain aborts, list the steps it never reached instead of implying the sweep covered them
- capture the real exit status in bg_run (exit ) or the task status lies

## Mistakes / Corrections
- mistake: reported 'genuine red, not a flake' from test output alone; correction: ps/lstart dated the squatter to S303 and the suite passes 11/11

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s307-full-verify.txt
- dashboard/playwright.config.js
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
