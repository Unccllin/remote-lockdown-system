# Session Capture — 2026-09-09 — sess-081

## Context
- Task: D-101 root cause investigation + D-206 bidirectional status sync
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
- D-101 root cause: QEMU 8.2.2 TPM device emulation hangs in Docker. SeaBIOS also hangs (not OVMF issue). swtpm never receives TPM commands from QEMU. Tested 13 configurations, all hang.
- Custom OVMF built with TPM2_ENABLE=TRUE using iasl from Docker acpica-tools — build succeeded but QEMU still hangs
- D-206 bidirectional status sync: syncPblStatusToAgent (pbl.js) + syncAgentStatusToPbl (devices.js) — best-effort, maps PBL status to agent status and vice versa
- Shared KV store singleton in server/src/pbl/kvStore.js — createSharedEnv() with _store getter
- Tests need beforeEach to reset shared KV store via setSharedKvStore(new Map())
- createEnv() in pbl.js now delegates to createSharedEnv() when no kvStore provided

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- server/src/pbl/kvStore.js (new)
- server/src/routes/pbl.js
- server/src/routes/devices.js
- server/tests/pblExpressRoutes.test.js
- server/tests/pblVerdictPolicyEnroll.test.js
- server/tests/pbl.routes.test.js
- server/tests/pblFullFlow.integration.test.js
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
