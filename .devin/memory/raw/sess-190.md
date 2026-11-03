# Session Capture — 2026-11-03 — sess-190

## Context
- Task: Fix the per-device installer paths: dashboard one-click .exe (NSIS/sc.exe) and ZIP (NSSM) shipped an agent Windows kills ~30s after boot.
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
- serverless/worker.ts still generates sc.exe installers in two places (handleInstaller ~1715 and the re-arm script ~2202); the Worker has no filesystem, so the fix needs the delegate published to KV.

## Mistakes / Corrections
- mistake: wrote the ruling from the Express generator alone without diffing the Worker's equivalent, so half of the same defect was left out of scope and became the next session's opening.

## Open Questions
- <none recorded>

## File References
- server/src/routes/installer.js, server/tests/installer.helpers.test.js, server/tests/installer.routes.test.js, agent/installer.py, agent/tests/test_installer.py, scripts/verify-environment.sh, docs/DEPLOYMENT.md, .devin/PENDING-RULING.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
