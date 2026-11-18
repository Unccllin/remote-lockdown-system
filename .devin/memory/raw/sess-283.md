# Session Capture — 2026-11-18 — sess-283

## Context
- Task: S280: extract the agent protocol (verifyAgentAuth + check-in, deadman, location, command-ACK, escrow) out of serverless/worker.ts into serverless/agent-routes.ts
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
- The moved text was verified byte-identical against git show HEAD:serverless/worker.ts modulo the 7 added export keywords; a scripted line-range move with boundary assertions beats retyping 513 lines.
- serverless/vitest.config.mts had 'include: [worker.ts]', so every module extracted since S277 was outside the coverage denominator — worker.ts's own score rose because 17% of the code left the measurement. Widened to '*.ts' + 'pbl/**/*.ts'; the honest whole-tree figure (86.36/82.99/95.04/88.52) still passes all four existing floors, so nothing was lowered.
- A shrinking coverage include is invisible: no gate reports it, because the number only goes up. Re-measure the denominator whenever code moves.
- scripts/audit_test_teeth.py rows are anchored by file path; 8 rows moved with the code and were repointed to agent-routes.ts.

## Mistakes / Corrections
- mistake: issued two brain.py writes in parallel — both allocated B-147 and one write was lost; correction: the store has no lock, run one write at a time and verify with brain.py list.
- mistake: expected the enroll-setup source-text assertion to keep passing after a move; correction: an assertion that reads one file by path goes vacuous (not red) when the code leaves that file, so it must read every module that can hold the line.
- mistake: my first boundary assertion checked line 1 for the header text when it is on line 2 (the file starts with '/**'); the script failed loudly before writing, which is why boundary assertions go first.

## Open Questions
- <none recorded>

## File References
- serverless/agent-routes.ts
- serverless/worker.ts
- serverless/vitest.config.mts
- serverless/enroll-setup.test.ts
- scripts/test_cross_surface_contract.py
- scripts/audit_test_teeth.py
- docs/artifacts/s280-agent-routes-split.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
