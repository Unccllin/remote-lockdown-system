# Session Capture — 2026-10-29 — sess-152

## Context
- Task: D-131: rule on unprovisioned PBL_AK_NAME and unknown device_id, then implement the server half
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
- D-131 is a lockdown bypass, not just an attestation gap: getDevice is an exact KV key read, enrolment stores the real AK hex, so the firmware's all-zero device_id always misses and the unknown-device branch returned UNLOCKED. The online path could never deliver locked/tracking/recovering.
- A test that asserts the current shape of a fallback cannot detect that the fallback is the vulnerability. The old serverless test asserted '200 + UNLOCKED for unknown device' - it was green and wrong in the same direction as the code.
- For every new fail-closed rule, add the negative test for the input the system actually produces (here the all-zero device_id), not a synthetic unknown id.
- Cross-layer defects need the consequence stated on every layer's side: D-131 looked like an attestation weakness from the firmware side and stayed unfunded until the server side was read.
- HttpsClient.c never inspects ResponseData.StatusCode, so C3 6.1's non-SUCCESS fallback is unreachable for HTTP errors - a server 404 currently arrives as EFI_SUCCESS and only falls back because COSE parsing fails.
- pbl-qemu:latest exists locally, so firmware build + QEMU boot are verifiable on this machine.

## Mistakes / Corrections
- Let a copy-paste from the Express test (createEnv/createApp) into the serverless test break the suite once; the serverless describe already provides env/kv/keys via beforeAll.
- Trusted four stale/misattributed STOP blockers (import pytest x2, let keys pointing at a comment line, a red test that reproduces green). Confirm with git show HEAD:, grep, or a direct re-run BEFORE editing, then confirm the finished state independently again.
- Nearly left the working tree holding the deliberately reintroduced bug during the teeth experiment; back the file up before patching, and verify the restore by grepping for the fixed symbol, not just by the test count.

## Open Questions
- <none recorded>

## File References
- serverless/pbl/routes/verdict.ts
- server/src/routes/pbl.js
- serverless/pbl.test.ts
- server/tests/pblVerdictPolicyEnroll.test.js
- docs/adr/PBL-C2-TPM-Contract.md
- docs/adr/PBL-C3-Network-Client.md
- docs/adr/PBL-DEBT-LEDGER.md
- .devin/PENDING-RULING.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
