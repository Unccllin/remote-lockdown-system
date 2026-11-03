# Session Capture — 2026-11-03 — sess-185

## Context
- Task: Declare integrations self-hosted-only (501), and fix a second live defect: the Worker discarded boot_lock_detail so a boot-lock no-op recorded as success
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
- Integrations inventory is a 442-line connector subsystem (registry + MeshCentral + typed errors + graph) reading process.env and calling upstream HTTP. Owner decision: self-hosted only; the Worker answers 501 (not 404, which is indistinguishable from a typo) after an auth check so anonymous callers learn nothing about the backend.
- SECOND live defect on the default path: handleCommandAck destructured boot_lock_status and boot_lock_detail and used neither. Express derives lockdown_effective (boot_lock_attempted && critical_applied_total > 0) and persists all three; the Worker dropped them, so a boot-lock no-op recorded as a plain success - precisely the E-EFFECTIVENESS/D-204 gap.
- Unknown must stay null, not false: 'never attempted' and 'attempted and failed' are both actionable and conflating them hides the dangerous one.
- The linter's 'unused' list contained both real dead code (verifyAdminAuth + 4 unused imports) and the discarded security signal (boot_lock_detail). Deleting the latter would have made the bug permanent; a field read-and-never-used has two possible causes and only reading the code distinguishes them.
- 385 tests; coverage 89.48/83.30/93.95/91.52; four mutations KILLED (501->200, critTotal>0 -> true, effectiveness never persisted, attempted-scope guard).

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- serverless/worker.ts
- serverless/worker.test.ts
- serverless/README.md
- scripts/audit_test_teeth.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
