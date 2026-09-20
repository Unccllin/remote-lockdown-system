# Session Capture — 2026-09-19 — sess-125

## Context
- Task: Verify and commit S1.1 TPM restart-counter boot-ID (TPM2_ReadClock → boot_id in verdict request)
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
- slirp 10.0.2.2 under docker --network host forwards to the HOST loopback, so a host-side mock server is reachable from the QEMU guest
- The committed firmware/policy.cose is a minimal dev blob (keys 1,2,70, no cert chain); verdict verification needs a FULL policy from 'test-d205.py --generate-policy' (cert chain key 77) or D-205 fail-closed rejects it
- pbl-qemu/-debian/-u22 docker images lack cryptography/cbor2 → in-container mock server not viable; run server on host with 'python3 -u' (unbuffered, else boot_id prints never flush to the log file)
- TPM2_ReadClock resetCount is the cold-boot ID (increments per TPM2_Startup CLEAR); restartCount is the S3-resume signal; emulated via swtpm reset=1

## Mistakes / Corrections
- Left a stale probe listener holding :8080 from a reachability test → next server bind failed EADDRINUSE; always kill probe listeners
- First harness run reported 'Invalid Parameter' on POST — was the dead in-container server (no deps), not a firmware bug

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/TpmClient.c
- firmware/PblPkg/PblApp/PlatformState.c
- firmware/PblPkg/PblApp/CborEncode.c
- firmware/PblPkg/test-s11-bootid-harness.sh
- firmware/PblPkg/test-d205.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
