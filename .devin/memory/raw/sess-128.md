# Session Capture — 2026-09-19 — sess-128

## Context
- Task: Implement S1.3 attestation enrichment — discrete CBOR fields on verdict wire
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
- S1.3 fields (FveProtectionMask/LoadedImageDigest/BootPathFlags) were already collected into PBL_PLATFORM_STATE — the work was lifting them into discrete CBOR keys 6/7/8, not new collection
- The verdict request map is now 8 keys (~149 bytes on wire)
- Must recopy PblApp.efi to the harness /test dir AFTER rebuild — a stale efi silently shows the old wire format

## Mistakes / Corrections
- First harness run showed the old 110-byte request because /test/PblApp.efi was copied before the rebuild — stale artifact

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/CborEncode.c
- firmware/PblPkg/PblApp/PblApp.c
- server/src/routes/pbl.js
- firmware/PblPkg/test-d205.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
