# Session Capture — 2026-09-19 — sess-126

## Context
- Task: Implement S1.2 cross-layer boot-ID absence correlation (server-side)
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
- The /v1/verdict fetch IS the firmware's boot report — recording boot_id + last_boot_at there gives a per-device boot ledger for free
- pbl/kvStore.js createSharedEnv/getSharedKvStore is the established seam for cross-route PBL state (devices.js syncAgentStatusToPbl already uses it)
- devices.pbl_device_id (migration 011) links an agent device to its PBL identity; set at enroll via SMBIOS UUID
- Server tests MUST run via 'npm test' (node --experimental-vm-modules) — plain npx jest crashes PGlite suites with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG
- Flag-only (DEGRADED alarm) is the right posture for boot_fresh=false: S3-resume produces the same signal until S1.4 restartCount disambiguates

## Mistakes / Corrections
- Ran plain 'npx jest' first → misleading PGlite VM crash; correct runner is 'npm test'

## Open Questions
- <none recorded>

## File References
- server/src/routes/pbl.js
- server/src/routes/agent.js
- server/tests/pblVerdictPolicyEnroll.test.js
- server/tests/agent.routes.test.js

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
