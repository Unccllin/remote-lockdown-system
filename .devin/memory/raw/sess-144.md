# Session Capture — 2026-10-27 — sess-144

## Context
- Task: Wire coverage gate into CI for all five components (audit P0 item)
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
- baselines measured not guessed: server 68.18/64.06/71.85/69.06, agent 61% stmts, dashboard 60.61/70.15/52.38/60.61, serverless 85.48/81.67/92.59/85.48, electron 39.4/47.36/30.95/39.3
- floors sit ~2 points under the measurement and are dated in each config; raise on improvement, never lower to pass
- run coverage scripts IN PLACE OF the plain test commands in CI: gate costs zero extra CI minutes and cannot drift from local
- pytest-cov decides on --cov-fail-under, NOT on coverage's fail_under in pyproject; set both to the same number
- vitest/jest thresholds are enforced per provider: jest coverageThreshold, vitest coverage.thresholds; both can be overridden on the CLI for negative testing

## Mistakes / Corrections
- mistake: read the first dashboard coverage failure as a coverage/instrumentation defect; the host was saturated by an unrelated project's ffmpeg render (load 26-46 on 8 cores). Check load average and process list before blaming the tool
- mistake: chained make test-coverage through 'tail -120' in a background task, losing most of the output; write to a log file instead

## Open Questions
- <none recorded>

## File References
- server/jest.config.js
- electron/jest.config.js
- dashboard/vitest.config.js
- dashboard/package.json
- serverless/vitest.config.js
- agent/pyproject.toml
- Makefile
- .github/workflows/ci.yml
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
